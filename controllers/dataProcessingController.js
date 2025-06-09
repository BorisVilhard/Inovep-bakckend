import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import xlsx from 'xlsx';
import winston from 'winston';
import Queue from 'bull';
import { Redis } from '@upstash/redis';
import Papa from 'papaparse';
import crypto from 'crypto';
import stream from 'stream';
import Dashboard from '../model/Data.js';
import {
	setCachedDashboard,
	getCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';
import { mergeDashboardData } from '../utils/dashboardUtils.js';
import {
	cleanNumeric,
	generateChartId,
	transformExcelDataToJSCode,
	extractJavascriptCode,
	transformDataStructure,
} from '../utils/dataTransform.js';

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

// Initialize GridFS
let gfs;
mongoose.connection.once('open', () => {
	gfs = new GridFSBucket(mongoose.connection.db, { bucketName: 'Uploads' });
	logger.info('GridFS initialized for MongoDB');
});

// Initialize Bull Queue for file deletion
const deletionQueue = new Queue('gridfs-deletion');

// Initialize Redis
const redis = Redis.fromEnv();

// Valid chart types
const validChartTypes = ['Area', 'Bar', 'Line', 'Pie', 'Scatter'];

/**
 * Sanitizes JSON string by removing non-printable characters and fixing JSON issues.
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
			.replace(/^\d/, '_$&')
			.trim() || 'unknown_column'
	);
}

/**
 * Validates the structure of an XLSX file.
 * @param {Buffer} fileBuffer - The file buffer.
 * @param {string} fileName - The name of the file.
 * @param {string} userId - The user ID.
 * @returns {boolean} - True if valid, false otherwise.
 */
function validateXlsxStructure(fileBuffer, fileName, userId) {
	try {
		const workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
		if (
			!workbook.SheetNames.length ||
			!workbook.Sheets[workbook.SheetNames[0]]
		) {
			logger.error('Invalid XLSX: No sheets or first sheet missing', {
				userId,
				fileName,
			});
			return false;
		}

		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = xlsx.utils.sheet_to_json(sheet, {
			raw: false,
			defval: null,
			header: 1,
		});
		logger.info('Extracted XLSX data', {
			userId,
			fileName,
			rowCount: data.length,
		});

		if (data.length === 0) {
			logger.warn('No data rows in XLSX', { userId, fileName });
		} else {
			data.forEach((row, index) => {
				if (Array.isArray(row)) {
					const invalidValues = row
						.filter(
							(val) =>
								val !== null &&
								typeof val === 'string' &&
								/[\x00-\x1F\x7F-\x9F]/.test(val)
						)
						.map((val) => ({ value: val, index }));
					if (invalidValues.length) {
						logger.warn('Invalid characters in row', {
							userId,
							fileName,
							rowIndex: index,
							invalidValues: invalidValues.slice(0, 5),
						});
					}
				}
			});
		}
		return true;
	} catch (error) {
		logger.error('Failed to validate XLSX', {
			userId,
			fileName,
			error: error.message,
		});
		return false;
	}
}

/**
 * Sanitizes Excel data by cleaning invalid characters.
 * @param {Array} data - The data array from sheet_to_json.
 * @returns {Array} - The sanitized data array.
 */
function sanitizeExcelData(data) {
	return data.map((row) => {
		const sanitizedRow = {};
		Object.entries(row).forEach(([key, val]) => {
			const sanitizedKey = sanitizeKey(key);
			sanitizedRow[sanitizedKey] =
				val !== null && typeof val === 'string'
					? val.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
					: val;
		});
		return sanitizedRow;
	});
}

/**
 * Parses an Excel file buffer into JSON data in a streaming manner.
 * @param {Buffer} buffer - The Excel file buffer.
 * @param {Function} onData - Callback for batch processing.
 * @returns {Promise<Array>} - The parsed data.
 */
async function parseExcelStream(buffer, onData) {
	const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
	const sheetName = workbook.SheetNames[0];
	const sheet = workbook.Sheets[sheetName];
	const data = [];
	const batchSize = 1000;

	const jsonData = xlsx.utils.sheet_to_json(sheet, {
		raw: false,
		defval: null,
	});
	for (let i = 0; i < jsonData.length; i += batchSize) {
		const batch = jsonData.slice(i, i + batchSize);
		data.push(...batch);
		onData(batch);
		await new Promise((resolve) => setTimeout(resolve, 0));
		logger.info(`Processed ${data.length} rows from Excel`, {
			fileName: sheetName,
		});
	}
	return data;
}

/**
 * Parses a CSV file buffer into JSON data.
 * @param {Buffer} buffer - The CSV file buffer.
 * @returns {Promise<Array>} - The parsed data.
 */
function parseCsv(buffer) {
	return new Promise((resolve, reject) => {
		Papa.parse(buffer.toString(), {
			header: true,
			chunkSize: 1000,
			step: (results) => {
				logger.info(`Processed CSV chunk`, { rowCount: results.data.length });
			},
			complete: (results) => resolve(results.data),
			error: (error) => reject(error),
		});
	});
}

/**
 * Limits dashboard data size to 8MB.
 * @param {Array} dashboardData - The dashboard data array.
 * @param {number} maxSizeBytes - Maximum size in bytes.
 * @returns {Array} - Truncated dashboard data.
 */
function limitDashboardDataSize(dashboardData, maxSizeBytes = 8 * 1024 * 1024) {
	let currentSize = 0;
	const limitedData = [];

	for (const category of dashboardData) {
		const categorySize = Buffer.byteLength(JSON.stringify(category), 'utf8');
		if (currentSize + categorySize <= maxSizeBytes) {
			limitedData.push(category);
			currentSize += categorySize;
		} else {
			break;
		}
	}

	logger.info('Limited dashboard data size', {
		originalSize: Buffer.byteLength(JSON.stringify(dashboardData), 'utf8'),
		limitedSize: currentSize,
		categoriesKept: limitedData.length,
	});
	return limitedData;
}

/**
 * Writes data to GridFS.
 * @param {string|ObjectId} fileId - The file ID.
 * @param {string} filename - The filename.
 * @param {string|Buffer} data - The data to write.
 * @param {string} contentType - The content type.
 * @param {Object} metadata - Metadata for the file.
 * @returns {Promise<string>} - The file ID.
 */
async function writeToGridFS(fileId, filename, data, contentType, metadata) {
	const writeStream = gfs.openUploadStreamWithId(
		mongoose.Types.ObjectId(fileId),
		filename,
		{ contentType, metadata }
	);
	writeStream.write(data);
	writeStream.end();
	await new Promise((resolve, reject) => {
		writeStream.on('finish', resolve);
		writeStream.on('error', reject);
	});
	return fileId.toString();
}

/**
 * POST /users/:userId/dashboard/upload
 * Creates or updates a dashboard with uploaded file data.
 */
export async function createOrUpdateDashboard(req, res) {
	const userId = req.params.userId;
	const start = Date.now();
	let chunkKey;

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
			'application/octet-stream',
		];
		const allowedExtensions = ['.csv', '.xlsx', '.xls'];
		const extension = fileName.toLowerCase().match(/\.[^\.]+$/)?.[0] || '';

		if (
			!allowedMimeTypes.includes(fileType) ||
			!allowedExtensions.includes(extension)
		) {
			logger.error('Invalid file type', {
				userId,
				fileName,
				fileType,
				extension,
			});
			return res.status(400).json({
				message: 'Only CSV and Excel (.csv, .xlsx, .xls) files are supported',
			});
		}

		let fileBuffer;
		const MAX_CHUNK_SIZE = 2 * 1024 * 1024;
		const MAX_FILE_SIZE = 6 * 1024 * 1024;
		chunkKey = `chunk:${userId}:${dashboardId || 'new'}:${fileName}`;

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
				});
				return res
					.status(400)
					.json({ message: 'Chunk size exceeds 2MB limit' });
			}

			await redis.rpush(chunkKey, file.buffer);
			logger.info('Stored chunk', {
				userId,
				fileName,
				chunkIndex: chunkIndexNum,
				totalChunks: totalChunksNum,
				chunkSize: file.buffer.length,
			});

			if (chunkIndexNum < totalChunksNum - 1) {
				const progress = ((chunkIndexNum + 1) / totalChunksNum) * 100;
				return res.status(200).json({
					message: `Chunk ${chunkIndexNum + 1} of ${totalChunksNum} uploaded`,
					chunkIndex,
					totalChunks: totalChunksNum,
					progress: progress.toFixed(2),
				});
			}

			const chunks = await redis.lrange(chunkKey, 0, -1);
			fileBuffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
			await redis.del(chunkKey);

			if (fileBuffer.length > MAX_FILE_SIZE) {
				logger.error('Reassembled file exceeds maximum size', {
					userId,
					fileName,
					fileSize: fileBuffer.length,
				});
				return res.status(400).json({ message: 'File size exceeds 6MB limit' });
			}
		} else {
			fileBuffer = file.buffer;
		}

		let rawData = [];
		const onDataBatch = (batch) => {
			rawData.push(...batch);
			logger.info(`Processed ${batch.length} rows`, { fileName });
		};

		if (fileName.endsWith('.csv')) {
			rawData = await parseCsv(fileBuffer);
		} else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
			if (!validateXlsxStructure(fileBuffer, fileName, userId)) {
				return res.status(400).json({
					message: 'Invalid XLSX structure',
					details:
						'Validation failed, but file may be processed with sanitization',
				});
			}
			rawData = await parseExcelStream(fileBuffer, onDataBatch);
			rawData = sanitizeExcelData(rawData);
		} else {
			return res.status(400).json({ message: 'Unsupported file type' });
		}

		let documentText;
		try {
			documentText = JSON.stringify(rawData);
			JSON.parse(documentText);
		} catch (jsonError) {
			try {
				documentText = sanitizeJsonString(JSON.stringify(rawData));
				JSON.parse(documentText);
			} catch (sanitizeError) {
				logger.error('Failed to sanitize JSON data', {
					userId,
					fileName,
					error: sanitizeError.message,
				});
				return res
					.status(400)
					.json({ message: 'File contains invalid or corrupted data' });
			}
		}

		const response = transformExcelDataToJSCode(documentText);
		const extractedData = extractJavascriptCode(response);
		const { dashboardData } = transformDataStructure(extractedData, fileName);

		if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
			logger.error('No valid dashboard data extracted', { userId, fileName });
			return res
				.status(400)
				.json({ message: 'No valid dashboard data extracted from file' });
		}

		const maxSizeBytes = 8 * 1024 * 1024;
		const limitedDashboardData = limitDashboardDataSize(
			dashboardData,
			maxSizeBytes
		);

		const isValid = limitedDashboardData.every(
			(category) =>
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
								typeof entry.date === 'string'
						)
				)
		);
		if (!isValid) {
			logger.error('Invalid dashboard data structure', { userId, fileName });
			return res
				.status(400)
				.json({ message: 'Invalid dashboard data structure' });
		}

		const dashboardDataJson = JSON.stringify(limitedDashboardData);
		const dashboardDataFileId = new mongoose.Types.ObjectId();
		const dashboardDataFilename = `dashboardData-${
			dashboardId || 'new'
		}-${Date.now()}.json`;
		await writeToGridFS(
			dashboardDataFileId,
			dashboardDataFilename,
			dashboardDataJson,
			'application/json',
			{ userId }
		);

		let fileId;
		let isChunked = false;
		const GRIDFS_THRESHOLD = 300 * 1024;
		if (fileBuffer.length > GRIDFS_THRESHOLD) {
			fileId = new mongoose.Types.ObjectId();
			await writeToGridFS(fileId, fileName, fileBuffer, fileType, { userId });
			isChunked = true;
		}

		const fileData = {
			fileId: fileId || new mongoose.Types.ObjectId().toString(),
			filename: fileName,
			content: isChunked ? undefined : fileBuffer,
			source: 'local',
			isChunked,
			chunkCount: totalChunks ? parseInt(totalChunks, 10) : 1,
			lastUpdate: new Date(),
			monitoring: { status: 'active' },
		};

		const dashboardDataRef = {
			fileId: dashboardDataFileId.toString(),
			filename: dashboardDataFilename,
			isChunked: true,
			chunkCount: 1,
			lastUpdate: new Date(),
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

			const existingDashboardData = await dashboard.getDashboardData();
			const mergedDashboardData = mergeDashboardData(
				existingDashboardData,
				limitedDashboardData
			);
			const finalDashboardData = limitDashboardDataSize(
				mergedDashboardData,
				maxSizeBytes
			);

			const mergedJson = JSON.stringify(finalDashboardData);
			if (Buffer.byteLength(mergedJson, 'utf8') > maxSizeBytes) {
				logger.error('Merged dashboard data exceeds 8MB limit', {
					userId,
					dashboardId,
				});
				return res
					.status(400)
					.json({ message: 'Merged data exceeds 8MB limit' });
			}

			const newFileId = new mongoose.Types.ObjectId();
			const newFilename = `dashboardData-${dashboardId}-${Date.now()}.json`;
			await writeToGridFS(
				newFileId,
				newFilename,
				mergedJson,
				'application/json',
				{ userId }
			);

			if (dashboard.dashboardDataRef?.fileId) {
				await deletionQueue.add(
					{ fileIds: [dashboard.dashboardDataRef.fileId] },
					{ attempts: 3 }
				);
			}

			dashboard.dashboardDataRef = {
				fileId: newFileId.toString(),
				filename: newFilename,
				isChunked: true,
				chunkCount: 1,
				lastUpdate: new Date(),
			};
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
				dashboardDataRef,
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
		const dashboardDataToCache = dashboardId
			? finalDashboardData
			: limitedDashboardData;
		let cacheWarning = null;

		try {
			const cacheKey = `dashboard:${userId}:${dashboard._id}:data`;
			const wasCached = await setCachedDashboard(
				userId,
				cacheKey,
				dashboardDataToCache
			);
			if (!wasCached) {
				cacheWarning =
					'Dashboard data too large to cache; stored in database only';
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboardData', {
				userId,
				dashboardId: dashboard._id,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard data due to server issue';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard processed successfully', {
			userId,
			dashboardId: dashboard._id.toString(),
			fileName,
			duration,
		});

		res.status(201).json({
			message: 'Dashboard processed successfully',
			dashboard: {
				_id: dashboard._id,
				dashboardName: dashboard.dashboardName,
				dashboardDataRef: dashboard.dashboardDataRef,
				files: dashboard.files,
				userId: dashboard.userId,
				createdAt: dashboard.createdAt,
				updatedAt: dashboard.updatedAt,
				dashboardData: dashboardDataToCache,
			},
			duration,
			cacheWarning,
		});
	} catch (error) {
		logger.error('Error in createOrUpdateDashboard', {
			userId,
			fileName: req.file?.originalname,
			error: error.message,
		});
		if (chunkKey) {
			await redis.del(chunkKey).catch((err) =>
				logger.error('Failed to clean up Redis chunks', {
					error: err.message,
				})
			);
		}
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * PUT /users/:userId/dashboard/:dashboardId/category/:categoryName
 * Updates category metadata.
 */
export async function updateCategoryData(req, res) {
	const { userId, dashboardId, categoryName } = req.params;
	const decodedCategoryName = decodeURIComponent(categoryName);

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
			logger.error('Dashboard not found', { dashboardId, userId });
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		const category = (await dashboard.getDashboardData()).find(
			(cat) => cat.categoryName === decodedCategoryName
		);
		if (!category) {
			logger.error('Category not found', {
				categoryName: decodedCategoryName,
				dashboardId,
				userId,
			});
			return res.status(404).json({ message: 'Category not found' });
		}

		const { appliedChartType, checkedIds } = req.body;
		if (appliedChartType && !validChartTypes.includes(appliedChartType)) {
			logger.error('Invalid chart type', {
				appliedChartType,
				userId,
				dashboardId,
			});
			return res.status(400).json({ message: 'Invalid chart type' });
		}

		category.appliedChartType = appliedChartType;
		category.checkedIds = checkedIds || [];

		const dashboardData = await dashboard.getDashboardData();
		const dashboardDataJson = JSON.stringify(dashboardData);
		const maxSizeBytes = 8 * 1024 * 1024;
		if (Buffer.byteLength(dashboardDataJson, 'utf8') > maxSizeBytes) {
			logger.error('Dashboard data exceeds 8MB limit', { userId, dashboardId });
			return res
				.status(400)
				.json({ message: 'Dashboard data exceeds 8MB limit' });
		}

		const dashboardDataFileId = new mongoose.Types.ObjectId();
		const dashboardDataFilename = `dashboardData-${dashboardId}-${Date.now()}.json`;
		await writeToGridFS(
			dashboardDataFileId,
			dashboardDataFilename,
			dashboardDataJson,
			'application/json',
			{ userId }
		);

		dashboard.dashboardDataRef = {
			fileId: dashboardDataFileId.toString(),
			filename: dashboardDataFilename,
			isChunked: true,
			chunkCount: 1,
			lastUpdate: new Date(),
		};
		await dashboard.save();

		let cacheWarning = null;
		try {
			const cacheKey = `dashboard:${userId}:${dashboard._id}:data`;
			const wasCached = await setCachedDashboard(
				userId,
				cacheKey,
				dashboardData
			);
			if (!wasCached) {
				cacheWarning =
					'Dashboard data too large to cache; stored in database only';
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboardData', {
				userId,
				dashboardId,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard data due to server issue';
		}

		logger.info('Updated category data', {
			userId,
			dashboardId,
			categoryName: decodedCategoryName,
		});
		res
			.status(200)
			.json({ message: 'Category data updated successfully', cacheWarning });
	} catch (error) {
		logger.error('Error updating category data', {
			userId,
			dashboardId,
			categoryName: decodedCategoryName,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * DELETE /users/:userId/dashboard/:dashboardId
 * Deletes a dashboard and its data.
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

		let cacheCleared = false;
		try {
			await Promise.all([
				deleteCachedDashboard(
					userId,
					`dashboard:${userId}:${dashboardId}:data`
				),
				deleteCachedDashboard(userId, `${dashboardId}:metadata`),
			]);
			cacheCleared = true;
		} catch (cacheError) {
			logger.error('Failed to clear cache', {
				userId,
				dashboardId,
				error: cacheError.message,
			});
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
		logger.error('Error in deleteDashboardData', {
			userId,
			dashboardId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId
 * Retrieves a specific dashboard's data.
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

		const cacheKey = `dashboard:${userId}:${dashboardId}:data`;
		const cachedDashboardData = await getCachedDashboard(userId, cacheKey);
		if (cachedDashboardData) {
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
			const duration = (Date.now() - start) / 1000;
			logger.info('Retrieved dashboardData from cache', {
				userId,
				dashboardId,
				duration,
			});
			return res.status(200).json({
				message: 'Dashboard data retrieved successfully',
				dashboard: {
					...dashboard.toObject(),
					dashboardData: cachedDashboardData,
				},
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
				cacheKey,
				dashboardData
			);
			if (!wasCached) {
				cacheWarning =
					'Dashboard data too large to cache; retrieved from database';
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboardData', {
				userId,
				dashboardId,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard data due to server issue';
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
		logger.error('Error in getDashboardData', {
			userId,
			dashboardId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * GET /users/:userId/dashboards
 * Retrieves all dashboards for a user.
 */
export async function getAllDashboards(req, res) {
	const { userId } = req.params;
	const start = Date.now();

	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			logger.error('Invalid userId', { userId });
			return res.status(400).json({ message: 'Invalid userId' });
		}

		const dashboards = await Dashboard.find(
			{ userId },
			{
				dashboardName: 1,
				dashboardDataRef: 1,
				files: 1,
				userId: 1,
				createdAt: 1,
				updatedAt: 1,
			}
		).lean();

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved all dashboards', {
			userId,
			dashboardCount: dashboards.length,
			duration,
		});

		res.status(200).json({
			message: 'Dashboards retrieved successfully',
			dashboards,
			duration,
		});
	} catch (error) {
		logger.error('Error in getAllDashboards', { userId, error: error.message });
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId/file/:fileId
 * Downloads the original uploaded file.
 */
export async function downloadDashboardFile(req, res) {
	const { userId, dashboardId, fileId } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(userId) ||
			!mongoose.Types.ObjectId.isValid(dashboardId) ||
			!mongoose.Types.ObjectId.isValid(fileId)
		) {
			logger.error('Invalid userId, dashboardId, or fileId', {
				userId,
				dashboardId,
				fileId,
			});
			return res
				.status(400)
				.json({ message: 'Invalid userId, dashboardId, or fileId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			logger.warn('Dashboard not found', { userId, dashboardId });
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		const fileData = dashboard.files.find((f) => f.fileId === fileId);
		if (!fileData) {
			logger.warn('File not found in dashboard', {
				userId,
				dashboardId,
				fileId,
			});
			return res.status(404).json({ message: 'File not found' });
		}

		if (!fileData.isChunked) {
			res.set({
				'Content-Type': fileData.contentType || 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${fileData.filename}"`,
			});
			res.send(fileData.content);
			const duration = (Date.now() - start) / 1000;
			logger.info('Served non-chunked file', {
				userId,
				dashboardId,
				fileId,
				duration,
			});
			return;
		}

		const downloadStream = gfs.openDownloadStream(
			new mongoose.Types.ObjectId(fileId)
		);
		res.set({
			'Content-Type': fileData.contentType || 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${fileData.filename}"`,
		});
		downloadStream.pipe(res);

		downloadStream.on('error', (error) => {
			logger.error('Error streaming file from GridFS', {
				userId,
				dashboardId,
				fileId,
				error: error.message,
			});
			if (!res.headersSent) {
				res.status(500).json({ message: 'Error streaming file' });
			}
		});

		downloadStream.on('end', () => {
			const duration = (Date.now() - start) / 1000;
			logger.info('File download completed', {
				userId,
				dashboardId,
				fileId,
				duration,
			});
		});
	} catch (error) {
		logger.error('Error in downloadDashboardFile', {
			userId,
			dashboardId,
			fileId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}
