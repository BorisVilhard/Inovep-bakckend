import mongoose from 'mongoose';
import { PdfReader } from 'pdfreader';
import { format } from 'date-fns';
import sharp from 'sharp';
import tesseract from 'tesseract.js';
import xlsx from 'xlsx';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import retry from 'async-retry';
import { Gauge } from 'prom-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { mergeDashboardData } from '../utils/dashboardUtils.js';
import { transformExcelDataToJSCode } from '../utils/transformExcel.js';
import { getGoogleDriveModifiedTime } from '../utils/googleDriveService.js';
import { getUserAuthClient } from '../utils/oauthService.js';
import { getTokens } from '../tokenStore.js';
import { google } from 'googleapis';
import Dashboard from '../model/Data.js';
import {
	getCachedDashboard,
	setCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';
import winston from 'winston';

// Prometheus metrics
const deletionDuration = new Gauge({
	name: 'dashboard_deletion_duration_seconds',
	help: 'Duration of dashboard deletion operations in seconds',
});
const gridFSDeletionErrors = new Gauge({
	name: 'gridfs_deletion_errors_total',
	help: 'Total number of GridFS deletion errors',
});

// Logger configuration
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'error.log', level: 'error' }),
		new winston.transports.File({ filename: 'combined.log' }),
	],
});

// In-memory store for chunks
const chunkStore = new Map();

// Promisified exec for backups
const execAsync = promisify(exec);

// Initialize GridFS for DigitalOcean MongoDB
let gfs;
mongoose.connection.once('open', () => {
	gfs = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
		bucketName: 'Uploads',
	});
	logger.info('GridFS initialized for DigitalOcean MongoDB');
});

/**
 * Middleware: Verify that the user making the request owns the resource.
 */
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user?.id;
	const userIdFromParams = req.params.id;
	if (!userIdFromToken || userIdFromToken !== userIdFromParams) {
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
};

/**
 * Helper: Retrieves a dashboard with caching.
 * @param {string} userId - User ID
 * @param {string} dashboardId - Dashboard ID
 * @returns {Promise<Object>} Cached or database dashboard object
 * @throws {Error} If dashboard ID is invalid or not found
 */
async function getDashboard(userId, dashboardId) {
	if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
		throw new Error('Invalid dashboard ID');
	}

	let dashboard = await getCachedDashboard(userId, dashboardId);
	if (!dashboard) {
		dashboard = await Dashboard.findOne({ _id: dashboardId, userId }).lean();
		if (!dashboard) {
			throw new Error(`Dashboard ID ${dashboardId} not found`);
		}
		await setCachedDashboard(userId, dashboardId, dashboard);
	}
	return dashboard;
}

/**
 * Helper: Creates a backup of the Dashboard collection using mongodump.
 * @returns {Promise<void>}
 */
async function backupDatabase() {
	try {
		if (!process.env.MONGODB_URI) {
			throw new Error('MONGODB_URI is not defined');
		}
		const backupDir = `backup_${Date.now()}`;
		await execAsync(
			`mongodump --uri="${process.env.MONGODB_URI}" --collection=Dashboard --out=${backupDir}`
		);
		logger.info('Database backup created', { backupDir });
	} catch (err) {
		logger.error('Error creating backup', { error: err.message });
		throw new Error(`Backup failed: ${err.message}`);
	}
}

/**
 * GET /users/:id/dashboard
 * Retrieves all dashboards for the given user.
 */
export const getAllDashboards = async (req, res) => {
	const userId = req.params.id;
	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}
		const dashboards = await Dashboard.find({ userId }).lean();
		if (!dashboards || dashboards.length === 0) {
			return res.status(204).json({ message: 'No dashboards found' });
		}
		res.json(dashboards);
	} catch (error) {
		logger.error('Error fetching dashboards', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId
 * Retrieves a specific dashboard.
 */
export const getDashboardById = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await getDashboard(userId, dashboardId);
		res.json(dashboard);
	} catch (error) {
		logger.error('Error fetching dashboard', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 400)
			.json({ message: error.message });
	}
};

/**
 * POST /users/:id/dashboard/create
 * Creates a new dashboard.
 */
export const createDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardName } = req.body;
	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}
		if (!dashboardName) {
			return res.status(400).json({ message: 'dashboardName is required' });
		}

		const existingDashboard = await Dashboard.findOne({
			dashboardName,
			userId,
		}).lean();
		if (existingDashboard) {
			return res.status(400).json({ message: 'Dashboard name already exists' });
		}

		const dashboard = new Dashboard({
			dashboardName,
			dashboardData: [],
			files: [],
			userId,
		});
		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboard._id, dashboardObj);

		res.status(201).json({
			message: 'Dashboard created successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error creating dashboard', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId
 * Updates an existing dashboard.
 */
export const updateDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	const { dashboardData, dashboardName } = req.body;
	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!dashboardData && !dashboardName) {
			return res
				.status(400)
				.json({ message: 'dashboardData or dashboardName is required' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		if (dashboardName && dashboardName !== dashboard.dashboardName) {
			const existingDashboard = await Dashboard.findOne({
				dashboardName,
				userId,
			}).lean();
			if (existingDashboard) {
				return res
					.status(400)
					.json({ message: 'Dashboard name already exists' });
			}
			dashboard.dashboardName = dashboardName;
		}

		if (dashboardData) {
			dashboard.dashboardData = dashboardData;
		}

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		res.json({
			message: 'Dashboard updated successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error updating dashboard', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 500)
			.json({ message: error.message });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId
 * Deletes a dashboard.
 */
export const deleteDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	const startTime = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Asynchronous backup
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		// Delete GridFS files in parallel without retries
		const deleteFilePromises = dashboard.files
			.filter((file) => file.fileId && file.isChunked)
			.map(async (file) => {
				try {
					await gfs.delete(new mongoose.Types.ObjectId(file.fileId));
					logger.info('GridFS file deleted', { fileId: file.fileId });
				} catch (err) {
					gridFSDeletionErrors.inc();
					logger.warn('Error deleting GridFS file', {
						fileId: file.fileId,
						error: err.message,
					});
				}
			});

		await Promise.all(deleteFilePromises);

		// Delete the dashboard document
		await Dashboard.deleteOne({ _id: dashboardId, userId });
		await deleteCachedDashboard(userId, dashboardId);

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Dashboard deleted', { userId, dashboardId, duration });

		res.json({ message: 'Dashboard deleted successfully' });
	} catch (error) {
		logger.error('Error deleting dashboard', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 500)
			.json({ message: error.message });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/file/:fileName
 * Removes data associated with a file from the dashboard or performs a dry-run.
 */
export const deleteDataByFileName = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, fileName } = req.params;
	const { dryRun, confirm } = req.query;
	const startTime = Date.now();

	try {
		// Validate inputs
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			logger.error('Invalid userId or dashboardId', { userId, dashboardId });
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!fileName || fileName === 'undefined') {
			logger.error('Invalid fileName', { fileName });
			return res
				.status(400)
				.json({ message: 'File name is required and cannot be undefined' });
		}

		// Fetch dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			logger.error('Dashboard not found', { userId, dashboardId });
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Check for file
		const file = dashboard.files.find((f) => f.filename === fileName);
		if (!file) {
			logger.error('File not found in dashboard', {
				userId,
				dashboardId,
				fileName,
			});
			return res.status(404).json({
				message: `File ${fileName} not found in dashboard ${dashboardId}`,
			});
		}

		// Count affected charts, entries, and categories
		let affectedCharts = 0;
		let affectedEntries = 0;
		const affectedCategories = new Set();
		dashboard.dashboardData.forEach((category) => {
			let categoryHasFileData = false;

			// Check mainData
			category.mainData.forEach((chart) => {
				const entries = chart.data.filter(
					(entry) => entry.fileName === fileName
				);
				if (entries.length > 0) {
					affectedCharts++;
					affectedEntries += entries.length;
					categoryHasFileData = true;
				}
			});

			// Check combinedData
			category.combinedData.forEach((chart) => {
				const entries = chart.data.filter(
					(entry) => entry.fileName === fileName
				);
				if (entries.length > 0) {
					affectedCharts++;
					affectedEntries += entries.length;
					categoryHasFileData = true;
				}
			});

			// Check summaryData
			const summaryEntries = category.summaryData.filter(
				(entry) => entry.fileName === fileName
			);
			if (summaryEntries.length > 0) {
				affectedEntries += summaryEntries.length;
				categoryHasFileData = true;
			}

			if (categoryHasFileData) {
				affectedCategories.add(category.categoryName);
			}
		});

		// Dry-run response
		if (dryRun === 'true') {
			logger.info('Dry-run deletion preview', {
				userId,
				dashboardId,
				fileName,
				affectedCharts,
				affectedEntries,
				affectedCategories: Array.from(affectedCategories),
			});
			return res.json({
				message: 'Dry run results',
				affectedCharts,
				affectedEntries,
				affectedCategories: Array.from(affectedCategories),
				affectedFile: file.filename,
			});
		}

		// Actual deletion
		if (confirm !== 'true') {
			logger.error('Confirmation required for deletion', {
				userId,
				dashboardId,
				fileName,
			});
			return res
				.status(400)
				.json({ message: 'Confirmation required for deletion' });
		}

		// Delete GridFS file if it exists
		if (file.fileId && file.isChunked) {
			try {
				await gfs.delete(new mongoose.Types.ObjectId(file.fileId));
				logger.info('GridFS file deleted', { fileId: file.fileId, fileName });
			} catch (err) {
				gridFSDeletionErrors.inc();
				logger.warn('Error deleting GridFS file', {
					fileId: file.fileId,
					error: err.message,
				});
			}
		}

		// Staged updates to remove file-related data
		// Step 1: Remove file from files array
		await Dashboard.updateOne(
			{ _id: dashboardId, userId },
			{
				$pull: {
					files: { filename: fileName },
				},
			},
			{ writeConcern: { w: 1 } }
		);

		// Step 2: Remove categories with any data tied to fileName
		const categoriesToRemove = [];
		dashboard.dashboardData.forEach((category) => {
			const hasMainData = category.mainData.some((chart) =>
				chart.data.some((entry) => entry.fileName === fileName)
			);
			const hasCombinedData = category.combinedData.some((chart) =>
				chart.data.some((entry) => entry.fileName === fileName)
			);
			const hasSummaryData = category.summaryData.some(
				(entry) => entry.fileName === fileName
			);
			if (hasMainData || hasCombinedData || hasSummaryData) {
				categoriesToRemove.push(category.categoryName);
			}
		});

		if (categoriesToRemove.length > 0) {
			await Dashboard.updateOne(
				{ _id: dashboardId, userId },
				{
					$pull: {
						dashboardData: {
							categoryName: { $in: categoriesToRemove },
						},
					},
				},
				{ writeConcern: { w: 1 } }
			);
		}

		// Step 3: Clean up remaining data for fileName
		const updateResult = await Dashboard.updateOne(
			{ _id: dashboardId, userId },
			{
				$pull: {
					'dashboardData.$[].mainData.$[].data': { fileName },
					'dashboardData.$[].combinedData.$[].data': { fileName },
					'dashboardData.$[].summaryData': { fileName },
				},
			},
			{ writeConcern: { w: 1 } }
		);

		// Fetch updated dashboard
		const updatedDashboard = await Dashboard.findOne({
			_id: dashboardId,
			userId,
		}).lean();
		if (updatedDashboard) {
			await setCachedDashboard(userId, dashboardId, updatedDashboard);
		}

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Data deleted by fileName', {
			userId,
			dashboardId,
			fileName,
			affectedCharts,
			affectedEntries,
			affectedCategories: Array.from(affectedCategories),
			modified: updateResult.modifiedCount,
			duration,
		});

		res.json({
			message: 'Data deleted successfully',
			affectedCharts,
			affectedEntries,
			affectedCategories: Array.from(affectedCategories),
			modified: updateResult.modifiedCount > 0,
			dashboard: updatedDashboard || {},
		});
	} catch (error) {
		logger.error('Error deleting data by fileName', {
			userId,
			dashboardId,
			fileName,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

export const dryRunDeleteDataByFileName = async (req, res) => {
	const { id: userId, dashboardId, fileName } = req.params;

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!fileName || fileName === 'undefined') {
			return res
				.status(400)
				.json({ message: 'File name is required and cannot be undefined' });
		}

		const dashboard = await Dashboard.findOne(
			{ _id: dashboardId, userId },
			{ files: 1, dashboardData: 1 }
		).lean();
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const file = dashboard.files.find((f) => f.filename === fileName);
		if (!file) {
			return res.status(404).json({
				message: `File ${fileName} not found in dashboard ${dashboardId}`,
			});
		}

		let affectedCharts = 0;
		let affectedEntries = 0;
		dashboard.dashboardData.forEach((category) => {
			category.mainData.forEach((chart) => {
				const entries = chart.data.filter(
					(entry) => entry.fileName === fileName
				);
				if (entries.length > 0) {
					affectedCharts++;
					affectedEntries += entries.length;
				}
			});
			category.combinedData.forEach((chart) => {
				const entries = chart.data.filter(
					(entry) => entry.fileName === fileName
				);
				if (entries.length > 0) {
					affectedCharts++;
					affectedEntries += entries.length;
				}
			});
		});

		res.json({
			message: 'Dry run results',
			affectedCharts,
			affectedEntries,
			affectedFile: file.filename,
		});
	} catch (error) {
		logger.error('Error in dry run deletion', {
			userId,
			dashboardId,
			fileName,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * DELETE /users/:id/dashboards
 * Deletes dashboards for a user, optionally by dashboardName.
 */
export const deleteLargeData = async (req, res) => {
	const userId = req.params.id;
	const { dashboardName } = req.body;
	const startTime = Date.now();

	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}

		// Perform backup asynchronously
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		const result = await Dashboard.deleteLargeData(userId, dashboardName);

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Large data deleted', {
			userId,
			dashboardName,
			deletedDashboards: result.deletedDashboards,
			deletedFiles: result.deletedFiles,
			duration,
		});

		res.status(200).json({
			message: 'Data deleted successfully',
			deletedDashboards: result.deletedDashboards,
			deletedFiles: result.deletedFiles,
		});
	} catch (error) {
		logger.error('Error deleting large data', {
			userId,
			dashboardName,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * DELETE /users/:id/dashboards/expired
 * Deletes expired files from dashboards.
 */
export const deleteExpiredFiles = async (req, res) => {
	const userId = req.params.id;
	const startTime = Date.now();

	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}

		// Perform backup asynchronously
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		const result = await Dashboard.deleteExpiredFiles();

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Expired files deleted', {
			userId,
			deletedFiles: result.deletedFiles,
			duration,
		});

		res.status(200).json({
			message: 'Expired files deleted successfully',
			deletedFiles: result.deletedFiles,
		});
	} catch (error) {
		logger.error('Error deleting expired files', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/data
 * Deletes all dashboardData for a specific dashboard.
 */
export const deleteDashboardData = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	const startTime = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		// Asynchronous backup
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		const result = await Dashboard.deleteDashboardData(dashboardId);

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Dashboard data deleted', {
			userId,
			dashboardId,
			modifiedCount: result.modifiedCount,
			deletedFiles: result.deletedFiles,
			duration,
		});

		// Update cache
		const cacheUpdate = async () => {
			const updatedDashboard = await Dashboard.findOne({
				_id: dashboardId,
				userId,
			}).lean();
			if (updatedDashboard) {
				await setCachedDashboard(userId, dashboardId, updatedDashboard);
			} else {
				await deleteCachedDashboard(userId, dashboardId);
			}
		};
		cacheUpdate().catch((err) =>
			logger.error('Error updating cache', { error: err.message })
		);

		res.json({
			message: 'Dashboard data deleted successfully',
			modified: result.modifiedCount > 0,
			deletedFiles: result.deletedFiles,
		});
	} catch (error) {
		logger.error('Error deleting dashboard data', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 500)
			.json({ message: error.message });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/category/:categoryName
 * Deletes a specific category from a dashboard.
 */
export const deleteDashboardCategory = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryName } = req.params;
	const startTime = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!categoryName) {
			return res.status(400).json({ message: 'Category name is required' });
		}

		// Asynchronous backup
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		const result = await Dashboard.deleteDashboardCategory(
			dashboardId,
			categoryName
		);

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Dashboard category deleted', {
			userId,
			dashboardId,
			categoryName,
			modifiedCount: result.modifiedCount,
			deletedFiles: result.deletedFiles,
			duration,
		});

		// Update cache
		const cacheUpdate = async () => {
			const updatedDashboard = await Dashboard.findOne({
				_id: dashboardId,
				userId,
			}).lean();
			if (updatedDashboard) {
				await setCachedDashboard(userId, dashboardId, updatedDashboard);
			} else {
				await deleteCachedDashboard(userId, dashboardId);
			}
		};
		cacheUpdate().catch((err) =>
			logger.error('Error updating cache', { error: err.message })
		);

		res.json({
			message: 'Dashboard category deleted successfully',
			modified: result.modifiedCount > 0,
			deletedFiles: result.deletedFiles,
		});
	} catch (error) {
		logger.error('Error deleting dashboard category', {
			userId,
			dashboardId,
			categoryName,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 500)
			.json({ message: error.message });
	}
};
/**
 * DELETE /users/:id/dashboards/condition
 * Deletes dashboards matching a condition (e.g., expired files or custom query).
 */
export const deleteLargeDataByCondition = async (req, res) => {
	const { id: userId } = req.params;
	const { condition } = req.body;
	const startTime = Date.now();

	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}
		if (!condition || typeof condition !== 'object') {
			return res
				.status(400)
				.json({ message: 'Valid condition object is required' });
		}

		// Sanitize condition to include userId
		const safeCondition = {
			...condition,
			userId: new mongoose.Types.ObjectId(userId),
		};

		// Asynchronous backup
		backupDatabase().catch((err) =>
			logger.error('Background backup failed', { error: err.message })
		);

		// Fetch dashboards to extract GridFS file IDs
		const dashboards = await Dashboard.find(safeCondition, {
			files: 1,
			_id: 1,
		}).lean();
		const fileIds = dashboards
			.flatMap((dashboard) => dashboard.files || [])
			.filter((file) => file.fileId && file.isChunked)
			.map((file) => new mongoose.Types.ObjectId(file.fileId));

		// Delete GridFS files in parallel without retries
		let deletedFiles = 0;
		if (fileIds.length > 0) {
			const deletePromises = fileIds.map(async (fileId) => {
				try {
					await gfs.delete(fileId); // Single attempt, no retries
					return 1;
				} catch (err) {
					gridFSDeletionErrors.inc();
					logger.warn('Error deleting GridFS file', {
						fileId,
						error: err.message,
					});
					return 0;
				}
			});
			const results = await Promise.all(deletePromises);
			deletedFiles = results.reduce((sum, count) => sum + count, 0);
		}

		// Delete dashboards using bulkWrite
		const bulkOps = dashboards.map((dashboard) => ({
			deleteOne: {
				filter: { _id: dashboard._id, userId },
			},
		}));

		let deletedCount = 0;
		if (bulkOps.length > 0) {
			const bulkResult = await Dashboard.bulkWrite(bulkOps);
			deletedCount = bulkResult.deletedCount || 0;

			// Clear cache for deleted dashboards
			const cachePromises = dashboards.map((dashboard) =>
				deleteCachedDashboard(userId, dashboard._id)
			);
			await Promise.all(cachePromises);
		}

		const duration = (Date.now() - startTime) / 1000;
		deletionDuration.set(duration);
		logger.info('Large-scale deletion completed', {
			userId,
			deletedCount,
			deletedFiles,
			duration,
		});

		res.json({
			message: `Successfully deleted ${deletedCount} dashboards and ${deletedFiles} files`,
			deletedDashboards: deletedCount,
			deletedFiles,
		});
	} catch (error) {
		logger.error('Error in large-scale deletion', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId/files
 * Retrieves an array of file names associated with the dashboard.
 */
export const getDashboardFiles = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await getDashboard(userId, dashboardId);
		const files = dashboard.files.map((file) => file.filename);
		res.json({ files });
	} catch (error) {
		logger.error('Error fetching dashboard files', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res
			.status(error.message.includes('not found') ? 404 : 500)
			.json({ message: error.message });
	}
};

/**
 * Extracts text from a document based on its type using memory-based processing.
 */
const getDocumentText = async (buffer, fileType) => {
	try {
		if (fileType === 'application/pdf') {
			const pdfReader = new PdfReader();
			return new Promise((resolve, reject) => {
				let text = '';
				pdfReader.parseBuffer(buffer, (err, item) => {
					if (err) {
						logger.error('Error parsing PDF', { error: err.message });
						reject(err);
					} else if (!item) {
						resolve(text);
					} else if (item.text) {
						text += item.text + ' ';
					}
				});
			});
		} else if (fileType === 'image/png' || fileType === 'image/jpeg') {
			const imageBuffer = await sharp(buffer).toBuffer();
			const result = await tesseract.recognize(imageBuffer);
			return result.data.text;
		} else if (
			fileType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			fileType === 'application/vnd.ms-excel' ||
			fileType === 'text/csv'
		) {
			const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			const data = xlsx.utils.sheet_to_json(sheet);
			return JSON.stringify(data);
		} else {
			throw new Error(`Unsupported file type: ${fileType}`);
		}
	} catch (error) {
		logger.error('Error extracting document text', {
			fileType,
			error: error.message,
		});
		throw error;
	}
};

function cleanNumeric(value) {
	if (typeof value === 'string') {
		const numMatch = value.match(/-?\d+(\.\d+)?/);
		if (numMatch) {
			const numStr = numMatch[0];
			return numStr.includes('.') ? parseFloat(numStr) : parseInt(numStr, 10);
		}
	}
	return value;
}

function generateChartId(categoryName, chartTitle) {
	if (typeof categoryName !== 'string') {
		logger.warn('categoryName is not a string', { categoryName });
		categoryName = String(categoryName);
	}
	if (typeof chartTitle !== 'string') {
		logger.warn('chartTitle is not a string', { chartTitle });
		chartTitle = String(chartTitle);
	}
	return `${categoryName.toLowerCase().replace(/\s+/g, '-')}-${chartTitle
		.toLowerCase()
		.replace(/\s+/g, '-')}`;
}

function extractJavascriptCode(response) {
	try {
		if (!response.startsWith('const data = [')) {
			logger.warn('Invalid AI response format', {
				responseSnippet: response.substring(0, 200),
			});
			return [];
		}

		const jsCodePattern = /const\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
		const match = response.match(jsCodePattern);
		if (!match) {
			logger.warn('No JavaScript array found in response', { response });
			return [];
		}

		let jsArrayString = match[1];
		const datePlaceholder = '__ISO_DATE__';
		const dateMap = new Map();
		let dateCounter = 0;
		jsArrayString = jsArrayString.replace(
			/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/g,
			(match) => {
				const placeholder = `${datePlaceholder}${dateCounter++}`;
				dateMap.set(placeholder, match);
				return placeholder;
			}
		);

		jsArrayString = jsArrayString
			.replace(/\/\/.*?\n/g, '')
			.replace(/(\w+):/g, '"$1":')
			.replace(/'/g, '"')
			.replace(/\b(null|undefined)\b/g, '"null"')
			.replace(/,\s*\]/g, ']')
			.replace(/,\s*\}/g, '}')
			.replace(/\s+/g, ' ')
			.replace(/\}\s*\{/g, '},{')
			.replace(/,(\s*[\]\}])/g, '$1');

		dateMap.forEach((date, placeholder) => {
			jsArrayString = jsArrayString.replace(`"${placeholder}"`, `"${date}"`);
		});

		const parsedData = JSON.parse(jsArrayString);
		if (!Array.isArray(parsedData)) {
			logger.warn('Parsed data is not an array', { parsedData });
			return [];
		}
		return parsedData;
	} catch (error) {
		logger.error('Error decoding JSON', {
			responseSnippet: response.substring(0, 200),
			error: error.message,
		});

		try {
			const partialMatch = response.match(/\[[\s\S]*?\]/);
			if (partialMatch) {
				let partialString = partialMatch[0];
				const dateMap = new Map();
				let dateCounter = 0;
				partialString = partialString.replace(
					/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/g,
					(match) => {
						const placeholder = `__ISO_DATE__${dateCounter++}`;
						dateMap.set(placeholder, match);
						return placeholder;
					}
				);
				partialString = partialString
					.replace(/\/\/.*?\n/g, '')
					.replace(/(\w+):/g, '"$1":')
					.replace(/'/g, '"')
					.replace(/\b(null|undefined)\b/g, '"null"')
					.replace(/,\s*\]/g, ']')
					.replace(/,\s*\}/g, '}')
					.replace(/\s+/g, ' ')
					.replace(/\}\s*\{/g, '},{')
					.replace(/,(\s*[\]\}])/g, '$1');
				dateMap.forEach((date, placeholder) => {
					partialString = partialString.replace(
						`"${placeholder}"`,
						`"${date}"`
					);
				});
				const partialData = JSON.parse(partialString);
				if (Array.isArray(partialData)) {
					logger.info('Recovered partial data', {
						itemCount: partialData.length,
					});
					return partialData;
				}
			}
		} catch (partialError) {
			logger.error('Failed to recover partial data', {
				error: partialError.message,
			});
		}
		return [];
	}
}

function transformDataStructure(data, fileName) {
	const dashboardData = [];
	const fallbackDate = format(new Date(), 'yyyy-MM-dd');
	const dateRegex = /^\d{4}-\d{2}(?:-\d{2})?$/;
	const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 1000;

	if (!Array.isArray(data) || data.length === 0) {
		logger.warn('transformDataStructure: No valid data provided', { data });
		return { dashboardData };
	}

	const isStringValue = (val) => {
		if (typeof val !== 'string') return false;
		if (!isNaN(parseFloat(val)) && isFinite(val)) return false;
		if (dateRegex.test(val.trim())) return false;
		return true;
	};

	let stringColumnKey = null;
	const keys = Object.keys(data[0] || {});
	if (keys.length > 0) {
		for (const key of keys) {
			if (data.every((item) => isStringValue(item[key]))) {
				stringColumnKey = key;
				break;
			}
		}
	}

	for (let i = 0; i < data.length; i += BATCH_SIZE) {
		const batch = data.slice(i, i + BATCH_SIZE);
		batch.forEach((item) => {
			if (!item || typeof item !== 'object') {
				logger.warn('Skipping invalid item in data', { item });
				return;
			}

			const keys = Object.keys(item);
			let detectedDate = null;
			for (const key of keys) {
				const val = item[key];
				if (typeof val === 'string' && dateRegex.test(val.trim())) {
					const trimmed = val.trim();
					detectedDate = trimmed.length === 7 ? trimmed + '-01' : trimmed;
					break;
				}
			}

			let categoryName =
				stringColumnKey &&
				item[stringColumnKey] &&
				String(item[stringColumnKey]).trim()
					? String(item[stringColumnKey]).trim()
					: keys.length > 0
					? String(item[keys[0]])
					: 'Unknown';

			const charts = [];
			for (const key of keys) {
				if (key === stringColumnKey) continue;
				const chartTitle = String(key);
				const value = item[key];
				let chartValue =
					typeof value === 'string' && !dateRegex.test(value.trim())
						? cleanNumeric(value)
						: value;
				const chartId = generateChartId(categoryName, chartTitle);
				charts.push({
					chartType: 'Area',
					id: chartId,
					data: [
						{
							title: chartTitle,
							value: chartValue,
							date: detectedDate || fallbackDate,
							fileName: fileName,
						},
					],
					isChartTypeChanged: false,
					fileName: fileName,
				});
			}

			dashboardData.push({
				categoryName: categoryName,
				mainData: charts,
				combinedData: [],
			});
		});
	}

	return { dashboardData };
}

/**
 * PUT /users/:id/dashboard/:dashboardId/chart/:chartId
 * Updates the chartType of a specific chart.
 */
export const updateChartType = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, chartId } = req.params;
	const { chartType } = req.body;
	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!chartType) {
			return res.status(400).json({ message: 'chartType is required' });
		}

		const validChartTypes = [
			'EntryArea',
			'IndexArea',
			'EntryLine',
			'IndexLine',
			'TradingLine',
			'IndexBar',
			'Bar',
			'Pie',
			'Line',
			'Radar',
			'Area',
		];
		if (!validChartTypes.includes(chartType)) {
			return res.status(400).json({
				message: `Invalid chartType. Must be one of: ${validChartTypes.join(
					', '
				)}`,
			});
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		let chartFound = false;
		for (let category of dashboard.dashboardData) {
			for (let chart of category.mainData) {
				if (chart.id === chartId) {
					chart.chartType = chartType;
					chart.isChartTypeChanged = true;
					chartFound = true;
					break;
				}
			}
			if (chartFound) break;
		}

		if (!chartFound) {
			return res.status(404).json({ message: `Chart ID ${chartId} not found` });
		}

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		res.json({
			message: 'ChartType updated successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error updating chartType', {
			userId,
			dashboardId,
			chartId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId/category/:categoryName
 * Updates a dashboard category’s data.
 */
export const updateCategoryData = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryName } = req.params;
	const { combinedData, summaryData, appliedChartType, checkedIds } = req.body;

	try {
		// Validate inputs
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			logger.error('Invalid userId or dashboardId', { userId, dashboardId });
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!categoryName) {
			logger.error('Category name is required', { userId, dashboardId });
			return res.status(400).json({ message: 'Category name is required' });
		}
		if (!combinedData && !summaryData && !appliedChartType && !checkedIds) {
			logger.error('At least one field is required', {
				userId,
				dashboardId,
				categoryName,
			});
			return res.status(400).json({
				message:
					'At least one field (combinedData, summaryData, appliedChartType, or checkedIds) is required',
			});
		}

		// Fetch dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			logger.error('Dashboard not found', { userId, dashboardId });
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Find category
		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryName
		);
		if (!category) {
			logger.error('Category not found', { userId, dashboardId, categoryName });
			return res
				.status(404)
				.json({ message: `Category ${categoryName} not found` });
		}

		// Validate and update fields
		if (combinedData) {
			if (!Array.isArray(combinedData)) {
				logger.error('Invalid combinedData format', {
					userId,
					dashboardId,
					categoryName,
				});
				return res
					.status(400)
					.json({ message: 'combinedData must be an array' });
			}
			const validChartTypes = [
				'EntryArea',
				'IndexArea',
				'EntryLine',
				'IndexLine',
				'TradingLine',
				'IndexBar',
				'Bar',
				'Pie',
				'Line',
				'Radar',
				'Area',
			];
			const isValidCombinedData = combinedData.every(
				(item) =>
					typeof item.id === 'string' &&
					validChartTypes.includes(item.chartType) &&
					Array.isArray(item.chartIds) &&
					item.chartIds.length >= 2 &&
					item.chartIds.every((id) => typeof id === 'string') &&
					Array.isArray(item.data) &&
					item.data.length > 0 &&
					item.data.every(
						(entry) =>
							typeof entry.title === 'string' &&
							entry.value !== undefined &&
							entry.date instanceof Date &&
							typeof entry.fileName === 'string'
					)
			);
			if (!isValidCombinedData) {
				logger.error('Invalid combinedData structure', {
					userId,
					dashboardId,
					categoryName,
					combinedDataSample: combinedData.slice(0, 2),
				});
				return res.status(400).json({
					message:
						'combinedData contains invalid entries; check id, chartType, chartIds, or data fields',
				});
			}
			category.combinedData = combinedData;
		}

		if (summaryData) {
			if (!Array.isArray(summaryData)) {
				logger.error('Invalid summaryData format', {
					userId,
					dashboardId,
					categoryName,
				});
				return res
					.status(400)
					.json({ message: 'summaryData must be an array' });
			}
			const isValidSummaryData = summaryData.every(
				(entry) =>
					typeof entry.title === 'string' &&
					entry.value !== undefined &&
					entry.date instanceof Date &&
					typeof entry.fileName === 'string'
			);
			if (!isValidSummaryData) {
				logger.error('Invalid summaryData structure', {
					userId,
					dashboardId,
					categoryName,
					summaryDataSample: summaryData.slice(0, 2),
				});
				return res.status(400).json({
					message:
						'summaryData contains invalid entries; check title, value, date, or fileName fields',
				});
			}
			category.summaryData = summaryData;
		}

		if (appliedChartType) {
			const validChartTypes = [
				'EntryArea',
				'IndexArea',
				'EntryLine',
				'IndexLine',
				'TradingLine',
				'IndexBar',
				'Bar',
				'Pie',
				'Line',
				'Radar',
				'Area',
			];
			if (!validChartTypes.includes(appliedChartType)) {
				logger.error('Invalid appliedChartType', {
					userId,
					dashboardId,
					categoryName,
					appliedChartType,
				});
				return res.status(400).json({
					message: `Invalid appliedChartType. Must be one of: ${validChartTypes.join(
						', '
					)}`,
				});
			}
			category.appliedChartType = appliedChartType;
		}

		if (checkedIds) {
			if (
				!Array.isArray(checkedIds) ||
				!checkedIds.every((id) => typeof id === 'string')
			) {
				logger.error('Invalid checkedIds format', {
					userId,
					dashboardId,
					categoryName,
				});
				return res
					.status(400)
					.json({ message: 'checkedIds must be an array of strings' });
			}
			category.checkedIds = checkedIds;
		}

		// Save dashboard
		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		logger.info('Category data updated successfully', {
			userId,
			dashboardId,
			categoryName,
		});

		res.json({
			message: 'Category data updated successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error updating category data', {
			userId,
			dashboardId,
			categoryName,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * POST /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart
 * Creates a CombinedChart by aggregating data from multiple charts.
 */
export const addCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId } = req.params;
	const { chartType, chartIds } = req.body;
	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (
			!chartType ||
			!chartIds ||
			!Array.isArray(chartIds) ||
			chartIds.length < 2
		) {
			return res.status(400).json({
				message:
					'chartType and at least two chartIds are required to create a CombinedChart',
			});
		}

		const validChartTypes = [
			'EntryArea',
			'IndexArea',
			'EntryLine',
			'IndexLine',
			'TradingLine',
			'IndexBar',
			'Bar',
			'Pie',
			'Line',
			'Radar',
			'Area',
		];
		if (!validChartTypes.includes(chartType)) {
			return res.status(400).json({
				message: `Invalid chartType. Must be one of: ${validChartTypes.join(
					', '
				)}`,
			});
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		const validChartIds = category.mainData.map((chart) => chart.id);
		const isValid = chartIds.every((id) => validChartIds.includes(id));
		if (!isValid) {
			return res
				.status(400)
				.json({ message: 'One or more chartIds are invalid' });
		}

		let aggregatedEntries = [];
		category.mainData.forEach((chart) => {
			if (chartIds.includes(chart.id)) {
				aggregatedEntries = [...aggregatedEntries, ...chart.data];
			}
		});

		const combinedChartId = `combined-${Date.now()}`;
		const combinedChart = {
			id: combinedChartId,
			chartType,
			chartIds,
			data: aggregatedEntries,
		};

		category.combinedData.push(combinedChart);
		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		res.status(201).json({
			message: 'CombinedChart created successfully',
			combinedChart,
		});
	} catch (error) {
		logger.error('Error adding CombinedChart', {
			userId,
			dashboardId,
			categoryId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId
 * Deletes a CombinedChart.
 */
export const deleteCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;
	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		const index = category.combinedData.findIndex(
			(chart) => chart.id === combinedChartId
		);
		if (index === -1) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}

		category.combinedData.splice(index, 1);
		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		res.status(200).json({ message: 'CombinedChart deleted successfully' });
	} catch (error) {
		logger.error('Error deleting CombinedChart', {
			userId,
			dashboardId,
			categoryId,
			combinedChartId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId
 * Updates an existing CombinedChart.
 */
export const updateCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;
	const { chartType, chartIds } = req.body;
	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		const combinedChart = category.combinedData.find(
			(chart) => chart.id === combinedChartId
		);
		if (!combinedChart) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}

		if (chartType) {
			const validChartTypes = [
				'EntryArea',
				'IndexArea',
				'EntryLine',
				'IndexLine',
				'TradingLine',
				'IndexBar',
				'Bar',
				'Pie',
				'Line',
				'Radar',
				'Area',
			];
			if (!validChartTypes.includes(chartType)) {
				return res.status(400).json({
					message: `Invalid chartType. Must be one of: ${validChartTypes.join(
						', '
					)}`,
				});
			}
			combinedChart.chartType = chartType;
		}

		if (chartIds) {
			if (!Array.isArray(chartIds) || chartIds.length < 2) {
				return res
					.status(400)
					.json({ message: 'At least two chartIds are required' });
			}
			const validChartIds = category.mainData.map((chart) => chart.id);
			const isValid = chartIds.every((id) => validChartIds.includes(id));
			if (!isValid) {
				return res
					.status(400)
					.json({ message: 'One or more chartIds are invalid' });
			}
			combinedChart.chartIds = chartIds;
			let aggregatedEntries = [];
			category.mainData.forEach((chart) => {
				if (chartIds.includes(chart.id)) {
					aggregatedEntries = [...aggregatedEntries, ...chart.data];
				}
			});
			combinedChart.data = aggregatedEntries;
		}

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		res.status(200).json({
			message: 'CombinedChart updated successfully',
			combinedChart,
		});
	} catch (error) {
		logger.error('Error updating CombinedChart', {
			userId,
			dashboardId,
			categoryId,
			combinedChartId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * POST /users/:id/dashboard/upload-chunk
 * Receives and stores a file chunk in memory.
 */
export const uploadChunk = async (req, res) => {
	try {
		const userId = req.params.id;
		const { chunkId, chunkIndex, totalChunks, fileName, fileType } = req.body;

		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}
		if (
			!req.file ||
			!chunkId ||
			chunkIndex == null ||
			!totalChunks ||
			!fileName ||
			!fileType
		) {
			return res
				.status(400)
				.json({ message: 'Missing required chunk metadata' });
		}

		const chunkIndexNum = parseInt(chunkIndex, 10);
		if (isNaN(chunkIndexNum) || chunkIndexNum < 0) {
			return res.status(400).json({ message: 'Invalid chunkIndex' });
		}

		const allowedTypes = [
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'text/csv',
		];
		if (!allowedTypes.includes(fileType)) {
			return res.status(400).json({
				message: 'Unsupported file type',
				receivedType: fileType,
				allowedTypes,
			});
		}

		if (!chunkStore.has(chunkId)) {
			chunkStore.set(chunkId, {
				chunks: new Array(parseInt(totalChunks, 10)).fill(null),
				totalChunks: parseInt(totalChunks, 10),
				fileName,
				fileType,
			});
		}

		const chunkData = chunkStore.get(chunkId);
		if (chunkIndexNum >= chunkData.totalChunks) {
			return res.status(400).json({ message: 'Invalid chunk index' });
		}

		chunkData.chunks[chunkIndexNum] = req.file.buffer;

		logger.info('Chunk received', {
			userId,
			chunkId,
			chunkIndex,
			totalChunks,
			fileName,
			fileType,
			chunkSize: req.file.buffer.length,
		});

		res.status(200).json({
			message: 'Chunk received successfully',
			chunkId,
			chunkIndex,
		});
	} catch (error) {
		logger.error('Error in uploadChunk', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		if (error.message.includes('Bad compressed size')) {
			res.status(400).json({ message: 'Invalid or corrupted Excel/CSV file' });
		} else {
			res.status(500).json({ message: 'Server error', error: error.message });
		}
	}
};

/**
 * POST /users/:id/dashboard/finalize-chunk
 * Reassembles chunks from memory, processes the file, and updates the dashboard.
 */
export const finalizeChunk = async (req, res) => {
	try {
		const userId = req.params.id;
		const { chunkId, dashboardId, fileName, totalChunks } = req.body;

		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!chunkId || !fileName || !totalChunks) {
			return res
				.status(400)
				.json({ message: 'Missing required finalize metadata' });
		}

		let dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		if (!chunkStore.has(chunkId)) {
			return res.status(400).json({ message: 'Chunk ID not found' });
		}

		const chunkData = chunkStore.get(chunkId);
		if (chunkData.totalChunks !== parseInt(totalChunks, 10)) {
			return res.status(400).json({ message: 'Mismatched total chunks' });
		}

		if (chunkData.chunks.some((chunk) => chunk === null)) {
			return res.status(400).json({ message: 'Incomplete chunks received' });
		}

		const fileBuffer = Buffer.concat(chunkData.chunks);

		let chunkDataParsed = [];
		if (fileName.endsWith('.csv')) {
			const parser = parse({ columns: true, trim: true });
			const chunkStream = Readable.from(fileBuffer);
			for await (const row of chunkStream.pipe(parser)) {
				chunkDataParsed.push(row);
			}
		} else {
			const workbook = xlsx.read(fileBuffer, {
				type: 'buffer',
				cellDates: true,
			});
			const sheetName = workbook.SheetNames[0];
			if (!sheetName) {
				return res
					.status(400)
					.json({ message: 'Excel/CSV file has no sheets' });
			}
			const sheet = workbook.Sheets[sheetName];
			if (!sheet) {
				return res
					.status(400)
					.json({ message: 'Invalid sheet in Excel/CSV file' });
			}
			chunkDataParsed = xlsx.utils.sheet_to_json(sheet, { raw: true });
			if (!chunkDataParsed || !Array.isArray(chunkDataParsed)) {
				return res
					.status(400)
					.json({ message: 'No valid data extracted from Excel/CSV file' });
			}
		}

		const documentText = JSON.stringify(chunkDataParsed);
		let response;
		try {
			response = transformExcelDataToJSCode(documentText);
			logger.info('AI transformation response', {
				userId,
				fileName,
				length: response.length,
			});
		} catch (transformError) {
			logger.error('Error transforming chunk data', {
				userId,
				fileName,
				error: transformError.message,
			});
			return res.status(500).json({
				message: `Data transformation failed: ${transformError.message}`,
			});
		}

		const extractedData = extractJavascriptCode(response);
		logger.info('Extracted data items', {
			userId,
			fileName,
			count: extractedData.length,
		});

		const { dashboardData: transformedDashboardData } = transformDataStructure(
			extractedData,
			fileName
		);

		if (!transformedDashboardData || transformedDashboardData.length === 0) {
			return res
				.status(400)
				.json({ message: 'No valid dashboard data extracted from chunk' });
		}

		const fileData = {
			fileId: new mongoose.Types.ObjectId().toString(),
			filename: fileName,
			content: transformedDashboardData,
			source: 'local',
			isChunked: true,
			chunkCount: totalChunks,
			monitoring: { status: 'active' },
		};

		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			transformedDashboardData
		);
		dashboard.files.push(fileData);
		await dashboard.save();

		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		chunkStore.delete(chunkId);

		res.status(201).json({
			message: 'Chunked file processed successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error in finalizeChunk', {
			userId,
			dashboardId,
			fileName,
			error: error.message,
			stack: error.stack,
		});
		if (error.message.includes('Bad compressed size')) {
			res.status(400).json({ message: 'Invalid or corrupted Excel/CSV file' });
		} else {
			res.status(500).json({ message: 'Server error', error: error.message });
		}
	} finally {
		if (chunkStore.has(req.body.chunkId)) {
			chunkStore.delete(req.body.chunkId);
		}
	}
};

/**
 * POST /users/:id/dashboard/:dashboardId/cloudText
 * Processes raw cloud text (e.g., from Google Drive) using GPT, merges the data into the dashboard,
 * and updates the dashboard in the database.
 */
export const processCloudText = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.params;
		const { fullText, fileName } = req.body;

		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}
		if (!fullText) {
			return res.status(400).json({ message: 'No fullText provided' });
		}
		if (!fileName) {
			return res.status(400).json({ message: 'No fileName provided' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		let cleanedText = removeEmptyOrCommaLines(fullText);
		cleanedText = removeExcessiveRepetitions(cleanedText, 3);

		const TEMPLATE = `
You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript.
Output only valid JavaScript code with proper JSON syntax:
- Use double quotes for strings.
- Do not include trailing commas.
- Do not include comments or extra text.
- Preserve ISO date strings (e.g., "2024-03-01T23:00:00.000Z") exactly as provided without modification.

Given the following text:
{document_text}

Transform it into table data as:
const data = [{...}, {...}];
`.trim();

		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({ document_text: cleanedText });

		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
			maxTokens: 4096,
		});
		const gptResponse = await model.predict(formattedPrompt);

		const extractedData = extractJavascriptCode(gptResponse);
		const { dashboardData } = transformDataStructure(extractedData, fileName);

		if (!dashboardData) {
			return res.status(400).json({ message: 'dashboardData is required' });
		}

		dashboard.files = dashboard.files.filter((f) => f.filename !== fileName);
		dashboard.dashboardData.forEach((category) => {
			category.mainData.forEach((chart) => {
				chart.data = chart.data.filter((entry) => entry.fileName !== fileName);
			});
			category.mainData = category.mainData.filter(
				(chart) => chart.data.length > 0
			);
		});
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(category) => category.mainData.length > 0
		);

		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);

		const fileData = {
			fileId: 'cloud-' + Date.now(),
			filename: fileName,
			content: dashboardData,
			lastUpdate: new Date(),
		};
		dashboard.files.push(fileData);

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboardId, dashboardObj);

		const io = req.app.get('io');
		io.to(dashboardId).emit('dashboard-updated', {
			dashboardId,
			dashboard: dashboardObj,
		});

		res.status(201).json({
			message: 'Cloud text processed and data stored successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error processing cloud text', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * POST /users/:id/dashboard/uploadCloud
 * Uploads pre-processed cloud data to update or create a dashboard.
 */
export const uploadCloudData = async (req, res) => {
	try {
		const userId = req.params.id;
		const {
			dashboardId,
			dashboardName,
			fileName,
			dashboardData,
			folderId,
			channelExpiration,
			fileId,
		} = req.body;

		if (!mongoose.Types.ObjectId.isValid(userId)) {
			return res.status(400).json({ message: 'Invalid userId' });
		}
		if (!fileId) {
			return res.status(400).json({
				message:
					'fileId is required. Please provide a valid Google Drive fileId.',
			});
		}
		if (
			!fileName ||
			!Array.isArray(dashboardData) ||
			dashboardData.length === 0
		) {
			return res.status(400).json({
				message: 'fileName and a non-empty dashboardData are required',
			});
		}

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.json({ message: 'No valid tokens found for user' });
		}

		const authClient = await getUserAuthClient(
			tokens.access_token,
			tokens.refresh_token,
			tokens.expiry_date
		);
		if (!authClient) {
			return res
				.status(401)
				.json({ message: 'Could not create an authenticated client' });
		}

		let lastUpdate = new Date();
		try {
			const modifiedTimeStr = await getGoogleDriveModifiedTime(
				fileId,
				authClient
			);
			if (modifiedTimeStr) lastUpdate = new Date(modifiedTimeStr);
		} catch (err) {
			logger.warn('Failed to fetch modifiedTime from Drive', {
				fileId,
				error: err.message,
			});
		}

		let expireDate = channelExpiration
			? new Date(channelExpiration)
			: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		if (isNaN(expireDate.getTime())) {
			expireDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		}

		let dashboard;
		if (dashboardId) {
			if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
				return res.status(400).json({ message: 'Invalid dashboardId' });
			}
			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				return res
					.status(404)
					.json({ message: `Dashboard ID ${dashboardId} not found` });
			}
		} else {
			const existing = await Dashboard.findOne({
				dashboardName,
				userId,
			}).lean();
			if (existing) {
				return res.status(400).json({
					message: `Dashboard name "${dashboardName}" already exists`,
				});
			}
			dashboard = new Dashboard({
				dashboardName,
				userId,
				dashboardData: [],
				files: [],
			});
		}

		dashboard.files = dashboard.files.filter((f) => f.filename !== fileName);
		dashboard.dashboardData.forEach((category) => {
			category.mainData.forEach((chart) => {
				chart.data = chart.data.filter((entry) => entry.fileName !== fileName);
			});
			category.mainData = category.mainData.filter(
				(chart) => chart.data.length > 0
			);
		});
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(category) => category.mainData.length > 0
		);
		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);

		dashboard.files.push({
			fileId,
			filename: fileName,
			content: dashboardData,
			lastUpdate,
			source: 'google',
			monitoring: { status: 'active', expireDate, folderId: folderId || null },
		});

		let attempts = 0;
		while (attempts < 5) {
			const mergedFileNames = new Set();
			dashboard.dashboardData.forEach((category) => {
				category.mainData.forEach((chart) => {
					chart.data.forEach((entry) => mergedFileNames.add(entry.fileName));
				});
			});
			if (mergedFileNames.size === dashboard.files.length) break;
			dashboard.files.forEach((fileRecord) => {
				if (!mergedFileNames.has(fileRecord.filename)) {
					dashboard.dashboardData = mergeDashboardData(
						dashboard.dashboardData,
						fileRecord.content
					);
				}
			});
			attempts++;
		}

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboard._id, dashboardObj);

		res.status(200).json({
			message: 'Cloud data uploaded successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error in uploadCloudData', {
			userId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId/check-monitored-files
 * Checks monitored files for updates since last login and pulls new data if modified.
 */
export const checkAndUpdateMonitoredFiles = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.params;

		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.json({ message: 'No valid tokens found for user' });
		}

		const authClient = await getUserAuthClient(
			tokens.access_token,
			tokens.refresh_token,
			tokens.expiry_date
		);
		const drive = google.drive({ version: 'v3', auth: authClient });

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const updatedFiles = [];
		for (const file of dashboard.files.filter(
			(f) => f.source === 'google' && f.monitoring.status === 'active'
		)) {
			const { fileId, filename, lastUpdate } = file;
			if (!fileId || fileId === filename) continue;

			try {
				const currentModifiedTime = await drive.files
					.get({ fileId, fields: 'modifiedTime' })
					.then((res) => res.data.modifiedTime);
				const storedDate = new Date(lastUpdate);
				const currentDate = new Date(currentModifiedTime);

				if (currentDate > storedDate) {
					const fileContent = await fetchFileContent(fileId, authClient);
					const dashboardData = await processFileContent(fileContent, filename);
					dashboard.files = dashboard.files.filter(
						(f) => f.filename !== filename
					);
					dashboard.dashboardData.forEach((category) => {
						category.mainData.forEach((chart) => {
							chart.data = chart.data.filter(
								(entry) => entry.fileName !== filename
							);
						});
						category.mainData = category.mainData.filter(
							(chart) => chart.data.length > 0
						);
					});
					dashboard.dashboardData = dashboard.dashboardData.filter(
						(category) => category.mainData.length > 0
					);
					dashboard.dashboardData = mergeDashboardData(
						dashboard.dashboardData,
						dashboardData
					);
					dashboard.files.push({
						fileId,
						filename,
						content: dashboardData,
						lastUpdate: currentDate,
						source: 'google',
						monitoring: file.monitoring,
					});
					updatedFiles.push({
						fileId,
						filename,
						lastUpdate: currentModifiedTime,
					});
				}
			} catch (err) {
				logger.warn(`Error checking file ${fileId}`, { error: err.message });
			}
		}

		if (updatedFiles.length > 0) {
			await dashboard.save();
			const dashboardObj = dashboard.toObject();
			await setCachedDashboard(userId, dashboardId, dashboardObj);
			const io = req.app.get('io');
			io.to(dashboardId).emit('dashboard-updated', {
				dashboardId,
				dashboard: dashboardObj,
			});
		}

		res.status(200).json({
			message:
				updatedFiles.length > 0
					? 'Updated monitored files'
					: 'No updates detected',
			updatedFiles,
		});
	} catch (error) {
		logger.error('Error checking monitored files', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

async function fetchFileContent(fileId, authClient) {
	const drive = google.drive({ version: 'v3', auth: authClient });
	try {
		const meta = await drive.files.get({ fileId, fields: 'mimeType' });
		const mimeType = meta.data.mimeType;
		let fileContent = '';

		if (mimeType === 'application/vnd.google-apps.document') {
			const docs = google.docs({ version: 'v1', auth: authClient });
			const docResp = await docs.documents.get({ documentId: fileId });
			fileContent = extractPlainText(docResp.data);
		} else if (
			mimeType === 'text/csv' ||
			mimeType === 'application/vnd.google-apps.spreadsheet'
		) {
			const csvResp = await drive.files.export(
				{ fileId, mimeType: 'text/csv' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');
		} else if (
			mimeType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			mimeType === 'application/vnd.ms-excel'
		) {
			const xlsxResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			const workbook = xlsx.read(new Uint8Array(xlsxResp.data), {
				type: 'array',
			});
			fileContent = workbook.SheetNames.map((sheetName) =>
				xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName])
			).join('\n\n');
		} else if (mimeType === 'text/plain') {
			const textResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'stream' }
			);
			fileContent = await new Promise((resolve, reject) => {
				let data = '';
				textResp.data.on('data', (chunk) => (data += chunk));
				textResp.data.on('end', () => resolve(data));
				textResp.data.on('error', reject);
			});
		} else {
			logger.warn(`Unsupported mimeType: ${mimeType} for file ${fileId}`);
			throw new Error(`Unsupported file type: ${mimeType}`);
		}

		logger.info('Fetched file content', {
			fileId,
			mimeType,
			contentLength: fileContent.length,
		});
		return fileContent;
	} catch (error) {
		logger.error('Error fetching file content', {
			fileId,
			error: error.message,
			stack: error.stack,
		});
		throw error;
	}
}

async function processFileContent(fullText, fileName) {
	try {
		let data;
		try {
			data = JSON.parse(fullText);
			if (!Array.isArray(data)) {
				throw new Error('Parsed data is not an array');
			}
		} catch (jsonError) {
			// Handle non-JSON text (e.g., Google Docs)
			logger.warn('Input is not JSON, treating as plain text', {
				fileName,
				error: jsonError.message,
			});
			data = fullText
				.split('\n')
				.filter((line) => line.trim())
				.map((line, index) => ({
					id: `entry-${index}`,
					value: line.trim(),
					date: format(new Date(), 'yyyy-MM-dd'),
				}));
		}

		const { dashboardData } = transformDataStructure(data, fileName);
		if (
			!dashboardData ||
			!Array.isArray(dashboardData) ||
			dashboardData.length === 0
		) {
			throw new Error('Invalid dashboardData structure');
		}

		// Validate dashboardData against DashboardCategorySchema
		const isValid = dashboardData.every((category) => {
			return (
				typeof category.categoryName === 'string' &&
				Array.isArray(category.mainData) &&
				category.mainData.every(
					(chart) =>
						typeof chart.id === 'string' &&
						typeof chart.chartType === 'string' &&
						Array.isArray(chart.data) &&
						chart.data.every(
							(entry) =>
								typeof entry.title === 'string' &&
								entry.value !== undefined &&
								typeof entry.date === 'string' &&
								typeof entry.fileName === 'string'
						)
				)
			);
		});
		if (!isValid) {
			throw new Error('dashboardData does not match expected schema');
		}

		logger.info('Processed file content', {
			fileName,
			dashboardDataLength: dashboardData.length,
		});
		return dashboardData;
	} catch (error) {
		logger.error('Error processing file content', {
			fileName,
			error: error.message,
			stack: error.stack,
		});
		throw error;
	}
}
function extractPlainText(doc) {
	if (!doc || !doc.body || !doc.body.content) {
		logger.warn('Invalid Google Doc structure', {
			doc: doc ? 'partial' : 'missing',
		});
		return '';
	}

	const textArray = [];
	for (const element of doc.body.content) {
		if (element.paragraph?.elements) {
			for (const pe of element.paragraph.elements) {
				if (pe.textRun?.content) {
					textArray.push(pe.textRun.content);
				}
			}
			textArray.push('\n');
		}
		// Handle tables if needed
		if (element.table?.tableRows) {
			for (const row of element.table.tableRows) {
				for (const cell of row.tableCells) {
					for (const cellElement of cell.content) {
						if (cellElement.paragraph?.elements) {
							for (const pe of cellElement.paragraph.elements) {
								if (pe.textRun?.content) {
									textArray.push(pe.textRun.content);
								}
							}
						}
					}
					textArray.push('\t');
				}
				textArray.push('\n');
			}
		}
	}

	const result = textArray.join('').trim();
	logger.info('Extracted plain text from Google Doc', {
		length: result.length,
	});
	return result;
}
function removeEmptyOrCommaLines(text) {
	return text
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed !== '' && trimmed !== ',';
		})
		.join('\n');
}

function removeExcessiveRepetitions(text, MAX_REPEAT_COUNT = 3) {
	const lines = text.split('\n');
	const cleanedLines = [];
	let lastLine = null;
	let repeatCount = 0;
	for (const line of lines) {
		if (line === lastLine) {
			repeatCount++;
			if (repeatCount <= MAX_REPEAT_COUNT) {
				cleanedLines.push(line);
			}
		} else {
			lastLine = line;
			repeatCount = 1;
			cleanedLines.push(line);
		}
	}
	return cleanedLines.join('\n');
}

/**
 * POST /users/:id/dashboard/upload
 * Creates or updates a dashboard with uploaded file data.
 * Stores files >200KB in GridFS, smaller files in BSON.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const createOrUpdateDashboard = async (req, res) => {
	const userId = req.params.id; // Define userId at top scope
	try {
		// Validate userId
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			logger.error('Invalid userId', { userId });
			return res.status(400).json({ message: 'Invalid userId' });
		}

		// Validate file upload
		if (!req.file) {
			logger.error('No file uploaded', { userId });
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const { dashboardId, dashboardName } = req.body;
		const file = req.file;
		const fileType = file.mimetype;
		const fileName = file.originalname;

		// Validate file type
		const allowedTypes = [
			'application/pdf',
			'image/png',
			'image/jpeg',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'text/csv',
		];
		if (!allowedTypes.includes(fileType)) {
			logger.error('Unsupported file type', { userId, fileType, fileName });
			return res.status(400).json({
				message: 'Unsupported file type',
				receivedType: fileType,
				allowedTypes,
			});
		}

		// Extract text
		let documentText;
		let fileId;
		let isChunked = false;
		const GRIDFS_THRESHOLD = 200 * 1024; // 200KB in bytes
		if (
			fileType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			fileType === 'application/vnd.ms-excel' ||
			fileType === 'text/csv'
		) {
			const workbook = xlsx.read(file.buffer, {
				type: 'buffer',
				cellDates: true,
			});
			if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
				logger.error('Excel/CSV file has no sheets', { userId, fileName });
				return res
					.status(400)
					.json({ message: 'Excel/CSV file has no sheets' });
			}
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			if (!sheet) {
				logger.error('Invalid sheet in Excel/CSV file', { userId, fileName });
				return res
					.status(400)
					.json({ message: 'Invalid sheet in Excel/CSV file' });
			}
			const data = xlsx.utils.sheet_to_json(sheet);
			if (!data || !Array.isArray(data)) {
				logger.error('No valid data extracted from Excel/CSV file', {
					userId,
					fileName,
				});
				return res
					.status(400)
					.json({ message: 'No valid data extracted from Excel/CSV file' });
			}
			logger.info('Excel/CSV processing details', {
				userId,
				fileName,
				sheetNames: workbook.SheetNames,
				dataLength: data.length,
			});
			documentText = JSON.stringify(data);

			// Store files >200KB in GridFS
			if (file.buffer.length > GRIDFS_THRESHOLD) {
				if (!gfs) {
					logger.error('GridFS not initialized', { userId, fileName });
					throw new Error('GridFS not initialized');
				}
				const writeStream = gfs.openUploadStream(fileName, {
					contentType: fileType,
					metadata: { userId },
				});
				writeStream.write(file.buffer);
				writeStream.end();
				fileId = await new Promise((resolve, reject) => {
					writeStream.on('finish', () => resolve(writeStream.id.toString()));
					writeStream.on('error', reject);
				});
				isChunked = true;
				logger.info('Stored file in GridFS', { userId, fileName, fileId });
			}
		} else if (fileType === 'application/pdf') {
			const pdfReader = new PdfReader();
			documentText = await new Promise((resolve, reject) => {
				let text = '';
				pdfReader.parseBuffer(file.buffer, (err, item) => {
					if (err) reject(err);
					else if (!item) resolve(text);
					else if (item.text) text += item.text + ' ';
				});
			});
		} else if (fileType === 'image/png' || fileType === 'image/jpeg') {
			const image = sharp(file.buffer);
			const buffer = await image.toBuffer();
			const result = await tesseract.recognize(buffer);
			documentText = result.data.text;
		} else {
			logger.error('Unexpected file type after validation', {
				userId,
				fileType,
				fileName,
			});
			throw new Error('Unexpected file type after validation');
		}

		logger.info('Extracted document text', {
			userId,
			fileName,
			length: documentText.length,
		});

		// Transform data
		let response;
		try {
			response = transformExcelDataToJSCode(documentText);
			logger.info('AI transformation response', {
				userId,
				fileName,
				length: response.length,
			});
		} catch (transformError) {
			logger.error('Error transforming data', {
				userId,
				fileName,
				error: transformError.message,
				stack: transformError.stack,
			});
			return res.status(500).json({
				message: `Data transformation failed: ${transformError.message}`,
			});
		}

		const extractedData = extractJavascriptCode(response);
		logger.info('Extracted data items', {
			userId,
			fileName,
			count: extractedData.length,
		});

		const { dashboardData } = transformDataStructure(extractedData, fileName);
		if (
			!dashboardData ||
			!Array.isArray(dashboardData) ||
			dashboardData.length === 0
		) {
			logger.error('No valid dashboard data extracted', { userId, fileName });
			return res
				.status(400)
				.json({ message: 'No valid dashboard data extracted' });
		}

		// Validate dashboardData against DashboardCategorySchema
		const isValid = dashboardData.every((category) => {
			return (
				typeof category.categoryName === 'string' &&
				Array.isArray(category.mainData) &&
				category.mainData.every(
					(chart) =>
						typeof chart.id === 'string' &&
						typeof chart.chartType === 'string' &&
						Array.isArray(chart.data) &&
						chart.data.every(
							(entry) =>
								typeof entry.title === 'string' &&
								entry.value !== undefined &&
								typeof entry.date === 'string' &&
								typeof entry.fileName === 'string'
						)
				)
			);
		});
		if (!isValid) {
			logger.error('Invalid dashboard data structure', { userId, fileName });
			return res
				.status(400)
				.json({ message: 'Invalid dashboard data structure' });
		}

		// Save to database
		const fileData = {
			fileId: fileId || new mongoose.Types.ObjectId().toString(),
			filename: fileName,
			content: isChunked ? undefined : dashboardData, // Store in GridFS if chunked
			source: 'local',
			isChunked,
			chunkCount: 1, // Always 1, as non-chunked files are treated as single "chunk"
			lastUpdate: new Date(),
			monitoring: { status: 'active' },
		};

		let dashboard;
		if (dashboardId) {
			if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
				logger.error('Invalid dashboard ID', { userId, dashboardId });
				return res.status(400).json({ message: 'Invalid dashboard ID' });
			}

			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				logger.error('Dashboard not found', { userId, dashboardId });
				return res
					.status(404)
					.json({ message: `Dashboard ID ${dashboardId} not found` });
			}
			dashboard.dashboardData = mergeDashboardData(
				dashboard.dashboardData,
				dashboardData
			);
			dashboard.files.push(fileData);
		} else if (dashboardName) {
			const existingDashboard = await Dashboard.findOne({
				dashboardName,
				userId,
			}).lean();
			if (existingDashboard) {
				logger.error('Dashboard name already exists', {
					userId,
					dashboardName,
				});
				return res
					.status(400)
					.json({ message: 'Dashboard name already exists' });
			}
			dashboard = new Dashboard({
				dashboardName,
				dashboardData,
				files: [fileData],
				userId,
			});
		} else {
			logger.error('dashboardId or dashboardName required', { userId });
			return res
				.status(400)
				.json({ message: 'dashboardId or dashboardName is required' });
		}

		await dashboard.save();
		const dashboardObj = dashboard.toObject();
		await setCachedDashboard(userId, dashboard._id, dashboardObj);

		logger.info('Dashboard processed successfully', {
			userId,
			dashboardId: dashboard._id.toString(),
			fileName,
			fileSize: file.buffer.length,
		});
		res.status(201).json({
			message: 'Dashboard processed successfully',
			dashboard: dashboardObj,
		});
	} catch (error) {
		logger.error('Error in createOrUpdateDashboard', {
			userId,
			fileName: req.file?.originalname,
			fileType: req.file?.mimetype,
			error: error.message,
			stack: error.stack,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};
