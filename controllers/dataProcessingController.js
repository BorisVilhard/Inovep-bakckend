import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import xlsx from 'xlsx';
import winston from 'winston';
import Queue from 'bull';
import { Redis } from '@upstash/redis';
import Papa from 'papaparse';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Dashboard from '../model/Data.js';
import {
	setCachedDashboard,
	getCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';
import { mergeDashboardData } from '../utils/dashboardUtils.js';

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

const deletionQueue = new Queue('gridfs-deletion');
let gfs;
mongoose.connection.once('open', () => {
	gfs = new GridFSBucket(mongoose.connection.db, { bucketName: 'Uploads' });
	logger.info('GridFS initialized for MongoDB');
});

const redis = Redis.fromEnv();

/**
 * Sanitizes JSON data by removing non-printable characters and fixing common JSON issues.
 * @param {string} jsonString - The JSON string to sanitize.
 * @returns {string} - The sanitized JSON string.
 */
function sanitizeJsonString(jsonString) {
	return jsonString
		.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
		.replace(/[\uFFFD]/g, '')
		.replace(/[^\x20-\x7E\t\n\r]/g, '')
		.replace(/([{,]\s*)(\w+)(?=\s*:)/g, '$1"$2"')
		.replace(/:\s*([^,\]}]+)(?=[,\]}])/g, (match, p1) => {
			if (/[^0-9.\-]/.test(p1.trim())) {
				return `: "${p1.trim().replace(/"/g, '\\"')}"`;
			}
			return match;
		});
}

/**
 * Sanitizes a string to be a valid JSON key.
 * @param {string} key - The key to sanitize.
 * @returns {string} - The sanitized key.
 */
function sanitizeKey(key) {
	return (
		key
			.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
			.replace(/[^\w\s-]/g, '')
			.replace(/\s+/g, '_')
			.replace(/^\d/, '_$&') // Ensure key doesn't start with a digit
			.trim() || 'unknown_column'
	);
}

/**
 * Validates the structure of an XLSX file and logs invalid data.
 * @param {Buffer} fileBuffer - The file buffer.
 * @param {string} fileName - The name of the file.
 * @param {string} userId - The user ID.
 * @returns {boolean} - True if valid, false if invalid.
 */
function validateXlsxStructure(fileBuffer, fileName, userId) {
	try {
		const workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
		if (
			!workbook.SheetNames.length ||
			!workbook.Sheets[workbook.SheetNames[0]]
		) {
			logger.error('Invalid or empty workbook', { userId, fileName });
			return false;
		}
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = xlsx.utils.sheet_to_json(sheet, { raw: false, defval: null });
		if (!data.length) {
			logger.error('No data in sheet', { userId, fileName });
			return false;
		}
		const invalidRows = [];
		data.forEach((row, index) => {
			const invalidValues = Object.entries(row).filter(
				([key, val]) =>
					val !== null &&
					typeof val === 'string' &&
					/[\x00-\x1F\x7F-\x9F]/.test(val)
			);
			if (invalidValues.length) {
				invalidRows.push({ rowIndex: index, invalidValues });
			}
		});
		const invalidKeys = Object.keys(data[0] || {}).filter((key) =>
			/[\x00-\x1F\x7F-\x9F]/.test(key)
		);
		if (invalidRows.length || invalidKeys.length) {
			logger.error('File contains invalid characters', {
				userId,
				fileName,
				invalidRows: invalidRows.slice(0, 5),
				invalidKeys,
			});
			return false;
		}
		return true;
	} catch (error) {
		logger.error('Failed to validate XLSX structure', {
			userId,
			fileName,
			error: error.message,
		});
		return false;
	}
}

/**
 * Sanitizes Excel data by cleaning invalid characters from string values and keys.
 * @param {Array} data - The data array from sheet_to_json.
 * @returns {Array} - The sanitized data array.
 */
function sanitizeExcelData(data) {
	return data.map((row) => {
		const sanitizedRow = {};
		Object.entries(row).forEach(([key, val]) => {
			const sanitizedKey = sanitizeKey(key);
			if (
				val !== null &&
				typeof val === 'string' &&
				/[\x00-\x1F\x7F-\x9F]/.test(val)
			) {
				sanitizedRow[sanitizedKey] = val.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
			} else {
				sanitizedRow[sanitizedKey] = val;
			}
		});
		return sanitizedRow;
	});
}

/**
 * Parses an Excel file buffer into JSON data.
 * @param {Buffer} buffer - The Excel file buffer.
 * @returns {Array} - The parsed data as an array of objects.
 */
function parseExcel(buffer) {
	const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
	const sheetName = workbook.SheetNames[0];
	const sheet = workbook.Sheets[sheetName];
	return xlsx.utils.sheet_to_json(sheet, { raw: false, defval: null });
}

/**
 * Parses a CSV file buffer into JSON data.
 * @param {Buffer} buffer - The CSV file buffer.
 * @returns {Promise<Array>} - A promise resolving to the parsed data as an array of objects.
 */
function parseCsv(buffer) {
	return new Promise((resolve, reject) => {
		Papa.parse(buffer.toString(), {
			header: true,
			complete: (results) => resolve(results.data),
			error: (error) => reject(error),
		});
	});
}

/**
 * Transforms data structure for dashboard storage.
 * @param {Array} data - The parsed data.
 * @param {string} fileName - The name of the file.
 * @returns {Object} - Transformed dashboard data.
 */
function transformDataStructure(data, fileName) {
	return {
		dashboardData: {
			categoryName: path.basename(fileName, path.extname(fileName)),
			mainData: data.map((item, index) => ({
				id: crypto.randomUUID(),
				chartType: 'bar',
				data: Object.entries(item).map(([key, value]) => ({
					title: key,
					value,
					date: new Date().toISOString(),
					fileName,
				})),
				isChartTypeChanged: false,
				fileName,
			})),
			combinedData: [],
		},
	};
}

/**
 * POST /users/:userId/dashboard/upload
 * Creates or updates a dashboard with uploaded CSV or Excel file data.
 * Supports chunked uploads for files larger than 300KB.
 * @param {Object} req - The request object containing userId, file, and optional dashboardId, dashboardName, chunkIndex, totalChunks.
 * @param {Object} res - The response object.
 * @returns {Promise<void>}
 */
// ... (previous imports and helper functions remain the same)

export async function createOrUpdateDashboard(req, res) {
	const userId = req.params.userId;
	let chunkKey;
	let cacheWarning = null;

	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			logger.error('Invalid userId', { userId });
			return res.status(400).json({ message: 'Invalid userId' });
		}

		const { dashboardId, dashboardName, chunkIndex, totalChunks } = req.body;
		const file = req.file;

		if (!file) {
			logger.error('No file uploaded', { userId });
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const fileType = file.mimetype;
		const fileName = file.originalname;

		logger.info('Processing file', {
			userId,
			fileName,
			fileType,
			fileSize: file.buffer.length,
		});

		const allowedMimeTypes = [
			'text/csv',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
		];
		if (!allowedMimeTypes.includes(fileType)) {
			logger.error('Invalid file type', { userId, fileName, fileType });
			return res.status(400).json({
				message: 'Only CSV and Excel (.csv, .xlsx, .xls) files are supported',
			});
		}

		let fileBuffer;
		const CHUNK_SIZE = 300 * 1024; // 300KB threshold
		const MAX_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
		const MAX_FILE_SIZE = 6 * 1024 * 1024; // 6MB
		chunkKey = `upload:${userId}:${dashboardId || 'new'}:${fileName}`;

		if (totalChunks && chunkIndex !== undefined) {
			const chunkIndexNum = parseInt(chunkIndex, 10);
			const totalChunksNum = parseInt(totalChunks, 10);

			if (
				isNaN(chunkIndexNum) ||
				isNaN(totalChunksNum) ||
				chunkIndexNum >= totalChunksNum
			) {
				logger.error('Invalid chunk parameters', {
					userId,
					chunkIndex,
					totalChunks,
				});
				return res.status(400).json({ message: 'Invalid chunk parameters' });
			}

			if (file.buffer.length > MAX_CHUNK_SIZE) {
				logger.error('Chunk size exceeds maximum', {
					userId,
					fileName,
					chunkIndex: chunkIndexNum,
					chunkSize: file.buffer.length,
					maxChunkSize: MAX_CHUNK_SIZE,
				});
				return res
					.status(400)
					.json({ message: 'Chunk size exceeds 2MB limit' });
			}

			const chunkBase64 = file.buffer.toString('base64');
			await redis.lpush(chunkKey, chunkBase64);

			if (chunkIndexNum < totalChunksNum - 1) {
				return res.status(200).json({
					message: `Chunk ${chunkIndexNum + 1} of ${totalChunksNum} uploaded`,
					chunkIndex: chunkIndexNum,
				});
			}

			const chunks = await redis.lrange(chunkKey, 0, -1);
			fileBuffer = Buffer.concat(
				chunks.map((chunk) => Buffer.from(chunk, 'base64'))
			);
			await redis.del(chunkKey);

			if (fileBuffer.length > MAX_FILE_SIZE) {
				logger.error('Reassembled file exceeds maximum size', {
					userId,
					fileName,
					fileSize: fileBuffer.length,
					maxFileSize: MAX_FILE_SIZE,
				});
				return res.status(400).json({ message: 'File size exceeds 6MB limit' });
			}
		} else {
			fileBuffer = file.buffer;
		}

		let rawData;
		if (fileName.endsWith('.csv')) {
			rawData = await parseCsv(fileBuffer);
		} else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
			if (!validateXlsxStructure(fileBuffer, fileName, userId)) {
				return res.status(400).json({ message: 'Invalid XLSX structure' });
			}
			rawData = sanitizeExcelData(parseExcel(fileBuffer));
		} else {
			return res.status(400).json({ message: 'Unsupported file type' });
		}

		const { dashboardData } = transformDataStructure(rawData, fileName);
		const dashboardDataFileId = new mongoose.Types.ObjectId();
		const dashboardDataFilename = `dashboardData-${
			dashboardId || 'new'
		}-${Date.now()}.json`;
		const writeStream = gfs.openUploadStreamWithId(
			dashboardDataFileId,
			dashboardDataFilename,
			{
				contentType: 'application/json',
				metadata: { userId },
			}
		);
		writeStream.write(JSON.stringify(dashboardData));
		writeStream.end();
		await new Promise((resolve, reject) => {
			writeStream.on('finish', resolve);
			writeStream.on('error', reject);
		});

		const dashboardDataRef = {
			fileId: dashboardDataFileId.toString(),
			filename: dashboardDataFilename,
			isChunked: !!totalChunks,
			chunkCount: totalChunks || 1,
			lastUpdate: new Date(),
		};

		let dashboard;
		if (dashboardId) {
			dashboard = await Dashboard.findOneAndUpdate(
				{ _id: dashboardId, userId },
				{ dashboardDataRef },
				{ new: true }
			);
			if (!dashboard) {
				return res.status(404).json({ message: 'Dashboard not found' });
			}
		} else {
			const existingDashboard = await Dashboard.findOne({
				dashboardName,
				userId,
			});
			if (existingDashboard) {
				return res
					.status(400)
					.json({ message: 'Dashboard name already exists' });
			}
			dashboard = new Dashboard({
				dashboardName,
				dashboardDataRef,
				files: [],
				userId,
			});
			await dashboard.save();
		}

		const dashboardObj = {
			...dashboard.toObject(),
			dashboardData: await dashboard.getDashboardData(),
		};
		const wasCached = await setCachedDashboard(
			userId,
			dashboard._id,
			dashboardObj
		);
		if (!wasCached) {
			cacheWarning = 'Dashboard too large to cache; stored in database only';
		}

		res.status(201).json({
			message: 'Dashboard processed successfully',
			dashboard: dashboardObj,
			rawData, // Added raw Excel data to the response
			cacheWarning,
		});
	} catch (error) {
		logger.error('Error in createOrUpdateDashboard', {
			userId,
			fileName: req.file?.originalname,
			error: error.message,
		});
		if (chunkKey) {
			await redis
				.del(chunkKey)
				.catch((err) =>
					logger.error('Failed to clean up Redis chunks', {
						error: err.message,
					})
				);
		}
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

// ... (deleteDashboardData and getDashboardData remain unchanged)

/**
 * DELETE /users/:userId/dashboard/:dashboardId
 * Deletes the dashboardData and associated files for a specified dashboard.
 */
export async function deleteDashboardData(req, res) {
	const { userId, dashboardId } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			logger.error('Invalid userId or dashboardId', { userId, dashboardId });
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			logger.warn('Dashboard not found', { userId, dashboardId });
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		const fileId = new mongoose.Types.ObjectId(
			dashboard.dashboardDataRef.fileId
		);
		await new Promise((resolve, reject) => {
			gfs.delete(fileId, (err) => (err ? reject(err) : resolve(null)));
		});

		const result = await Dashboard.deleteOne({ _id: dashboardId, userId });
		if (result.deletedCount === 0) {
			return res
				.status(404)
				.json({ message: 'Dashboard not found or already deleted' });
		}

		const maxRetries = 3;
		let cacheCleared = false;
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await Promise.all([
					deleteCachedDashboard(userId, dashboardId),
					deleteCachedDashboard(userId, `${dashboardId}:metadata`),
				]);
				cacheCleared = true;
				break;
			} catch (cacheError) {
				if (attempt === maxRetries) {
					logger.error('Failed to clear cache after retries', {
						userId,
						dashboardId,
						error: cacheError.message,
					});
				}
			}
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard data deletion completed', {
			userId,
			dashboardId,
			deletedCount: result.deletedCount,
			cacheCleared,
			duration,
		});

		res.status(200).json({
			message: 'Dashboard data deleted successfully',
			deletedCount: result.deletedCount,
			cacheCleared,
			duration,
		});
	} catch (error) {
		logger.error('Error in deleteDashboardData controller', {
			userId,
			dashboardId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId
 * Retrieves the dashboard data for a specified dashboard.
 */
export async function getDashboardData(req, res) {
	const { userId, dashboardId } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId)
		) {
			logger.error('Invalid userId or dashboardId', { userId, dashboardId });
			return res.status(400).json({ message: 'Invalid userId or dashboardId' });
		}

		const cachedDashboard = await getCachedDashboard(userId, dashboardId);
		if (cachedDashboard) {
			const duration = (Date.now() - start) / 1000;
			logger.info('Retrieved dashboard data from cache', {
				userId,
				dashboardId,
				duration,
			});
			return res.status(200).json({
				message: 'Dashboard data retrieved successfully',
				dashboard: cachedDashboard,
				duration,
			});
		}

		const dashboard = await Dashboard.findOne(
			{ _id: dashboardId, userId },
			{
				dashboardName: 1,
				dashboardDataRef: 1,
				files: 1,
				userId: 1,
				createdAt: 1,
				updatedAt: 1,
			}
		);
		if (!dashboard) {
			logger.warn('Dashboard not found', { userId, dashboardId });
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		const dashboardData = await dashboard.getDashboardData();
		const dashboardObj = { ...dashboard.toObject(), dashboardData };

		let cacheWarning = null;
		try {
			const wasCached = await setCachedDashboard(
				userId,
				dashboardId,
				dashboardObj
			);
			if (!wasCached) {
				cacheWarning = 'Dashboard too large to cache; retrieved from database';
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboard', {
				userId,
				dashboardId,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard due to server issue';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved dashboard data from database', {
			userId,
			dashboardId,
			categoryCount: dashboardData.length,
			duration,
		});

		res.status(200).json({
			message: 'Dashboard data retrieved successfully',
			dashboard: dashboardObj,
			duration,
			cacheWarning,
		});
	} catch (error) {
		logger.error('Error in getDashboardData controller', {
			userId,
			dashboardId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}
