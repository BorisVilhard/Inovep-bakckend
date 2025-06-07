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
import stream from 'stream';
import Dashboard from '../model/Data.js';
import {
	setCachedDashboard,
	getCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';
import { mergeDashboardData } from '../utils/dashboardUtils.js';
import {
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
 * @returns {boolean} - True if valid, false if invalid with detailed logging.
 */
function validateXlsxStructure(fileBuffer, fileName, userId) {
	try {
		const workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
		logger.info('Validating workbook', {
			userId,
			fileName,
			sheetCount: workbook.SheetNames.length,
		});

		if (!workbook.SheetNames.length) {
			logger.error('No sheets found in workbook', { userId, fileName });
			return false;
		}
		if (!workbook.Sheets[workbook.SheetNames[0]]) {
			logger.error('First sheet is invalid or missing', { userId, fileName });
			return false;
		}

		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = xlsx.utils.sheet_to_json(sheet, {
			raw: false,
			defval: null,
			header: 1,
		});
		logger.info('Extracted data from sheet', {
			userId,
			fileName,
			rowCount: data.length,
		});

		if (data.length === 0) {
			logger.warn(
				'No data rows found in sheet, proceeding with headers if present',
				{ userId, fileName }
			);
		} else {
			const invalidRows = [];
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
						invalidRows.push({ rowIndex: index, invalidValues });
						logger.warn('Found invalid characters in row', {
							userId,
							fileName,
							rowIndex: index,
							invalidValues: invalidValues.slice(0, 5),
						});
					}
				}
			});

			const invalidKeys = Object.keys(data[0] || {}).filter((key) =>
				/[\x00-\x1F\x7F-\x9F]/.test(key)
			);
			if (invalidKeys.length) {
				logger.warn('Found invalid characters in keys', {
					userId,
					fileName,
					invalidKeys,
				});
			}
		}

		logger.info(
			'XLSX structure validated successfully (with warnings if applicable)',
			{ userId, fileName }
		);
		return true;
	} catch (error) {
		logger.error('Failed to validate XLSX structure', {
			userId,
			fileName,
			error: error.message,
			stack: error.stack,
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
			if (val !== null && typeof val === 'string') {
				sanitizedRow[sanitizedKey] = val.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
			} else {
				sanitizedRow[sanitizedKey] = val;
			}
		});
		return sanitizedRow;
	});
}

/**
 * Parses an Excel file buffer into JSON data in a streaming manner.
 * @param {Buffer} buffer - The Excel file buffer.
 * @param {Function} onData - Callback for batch processing.
 * @returns {Promise<Array>} - Promise resolving to the parsed data.
 */
async function parseExcelStream(buffer, onData) {
	const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
	const sheetName = workbook.SheetNames[0];
	const sheet = workbook.Sheets[sheetName];
	const data = [];
	const batchSize = 1000;
	let rowIndex = 0;

	const jsonData = xlsx.utils.sheet_to_json(sheet, {
		raw: false,
		defval: null,
	});
	for (let i = 0; i < jsonData.length; i += batchSize) {
		const batch = jsonData.slice(i, i + batchSize);
		data.push(...batch);
		onData(batch);
		await new Promise((resolve) => setTimeout(resolve, 0));
		rowIndex += batch.length;
		logger.info(`Processed ${rowIndex} rows from Excel`, {
			fileName: sheetName,
		});
	}
	return data;
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
			chunkSize: 1000,
			step: (results, parser) => {
				logger.info(`Processed CSV chunk`, { rowCount: results.data.length });
			},
			complete: (results) => resolve(results.data),
			error: (error) => reject(error),
		});
	});
}

/**
 * Limits the size of dashboardData to a maximum of 8MB.
 * @param {Array} dashboardData - The dashboard data array.
 * @param {number} maxSizeBytes - Maximum size in bytes (e.g., 8MB = 8 * 1024 * 1024).
 * @returns {Array} - Truncated dashboardData within size limit.
 */
function limitDashboardDataSize(dashboardData, maxSizeBytes = 8 * 1024 * 1024) {
	let currentSize = 0;
	const limitedData = [];

	for (const category of dashboardData) {
		const categoryJson = JSON.stringify(category);
		const categorySize = Buffer.byteLength(categoryJson, 'utf8');

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
		maxSizeBytes,
		categoriesKept: limitedData.length,
		totalCategories: dashboardData.length,
	});

	return limitedData;
}

/**
 * POST /users/:userId/dashboard/upload
 * Creates or updates a dashboard with uploaded CSV or Excel file data.
 * Supports chunked uploads for files larger than 300KB.
 * @param {Object} req - The request object containing userId, file, and optional dashboardId, dashboardName, chunkIndex, totalChunks.
 * @param {Object} res - The response object.
 * @returns {Promise<void>}
 */
export async function createOrUpdateDashboard(req, res) {
	const userId = req.params.userId;
	const start = Date.now();
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
		const CHUNK_SIZE = 300 * 1024;
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
					chunkSize: file.buffer.length,
					maxChunkSize: MAX_CHUNK_SIZE,
				});
				return res
					.status(400)
					.json({ message: 'Chunk size exceeds 2MB limit' });
			}

			const chunkHash = crypto
				.createHash('md5')
				.update(file.buffer)
				.digest('hex');
			logger.info('Stored chunk', {
				userId,
				fileName,
				chunkIndex: chunkIndexNum,
				totalChunks: totalChunksNum,
				chunkSize: file.buffer.length,
				chunkHash,
			});

			await redis.lpush(chunkKey, file.buffer);

			if (chunkIndexNum < totalChunksNum - 1) {
				const progress = ((chunkIndexNum + 1) / totalChunksNum) * 100;
				return res.status(200).json({
					message: `Chunk ${chunkIndexNum + 1} of ${totalChunksNum} uploaded`,
					chunkIndex: chunkIndexNum,
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
					maxFileSize: MAX_FILE_SIZE,
				});
				return res.status(400).json({ message: 'File size exceeds 6MB limit' });
			}
		} else {
			fileBuffer = file.buffer;
		}

		// Stream processing for large files
		let rawData = [];
		const onDataBatch = (batch) => {
			rawData.push(...batch);
			logger.info(`Processed batch of ${batch.length} rows`, {
				userId,
				fileName,
			});
		};

		if (fileName.endsWith('.csv')) {
			rawData = await parseCsv(fileBuffer);
		} else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
			if (!validateXlsxStructure(fileBuffer, fileName, userId)) {
				return res.status(400).json({
					message: 'Invalid XLSX structure',
					details:
						'Validation failed due to potential invalid characters or empty data, but file may still be processed with sanitization.',
				});
			}
			rawData = await parseExcelStream(fileBuffer, onDataBatch);
			rawData = sanitizeExcelData(rawData); // Ensure invalid characters are cleaned
		} else {
			return res.status(400).json({ message: 'Unsupported file type' });
		}

		let documentText;
		try {
			documentText = JSON.stringify(rawData);
			JSON.parse(documentText);
		} catch (jsonError) {
			logger.error('Invalid JSON data from file', {
				userId,
				fileName,
				error: jsonError.message,
			});
			try {
				documentText = sanitizeJsonString(JSON.stringify(rawData));
				JSON.parse(documentText);
			} catch (sanitizeError) {
				logger.error('Failed to sanitize JSON data', {
					userId,
					fileName,
					error: sanitizeError.message,
				});
				return res.status(400).json({
					message:
						'File contains invalid or corrupted data. Please ensure the file has valid tabular data without special characters or macros.',
				});
			}
		}
		logger.info('Raw JSON data', {
			userId,
			fileName,
			dataSnippet: documentText.substring(0, 200),
		});

		let response;
		try {
			response = transformExcelDataToJSCode(documentText);
			logger.info('Transformation response', {
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

		let extractedData;
		try {
			extractedData = extractJavascriptCode(response);
			logger.info('Extracted data items', {
				userId,
				fileName,
				count: extractedData.length,
				sampleExtracted: extractedData.slice(0, 3),
			});
		} catch (extractError) {
			logger.error('Failed to extract JavaScript code', {
				userId,
				fileName,
				error: extractError.message,
				responseSnippet: response.substring(0, 200),
			});
			return res.status(400).json({
				message:
					'Failed to process file data. Please ensure the file contains valid data.',
			});
		}

		const { dashboardData } = transformDataStructure(extractedData, fileName);
		if (
			!dashboardData ||
			!Array.isArray(dashboardData) ||
			dashboardData.length === 0
		) {
			logger.error('No valid dashboard data extracted', {
				userId,
				fileName,
				extractedDataSample: extractedData.slice(0, 3),
			});
			return res.status(400).json({
				message:
					'No valid dashboard data extracted from file. Ensure the file contains tabular data with string and numeric/date columns.',
			});
		}

		// Limit dashboardData size to 8MB
		const maxSizeBytes = 8 * 1024 * 1024; // 8MB in bytes
		const limitedDashboardData = limitDashboardDataSize(
			dashboardData,
			maxSizeBytes
		);

		const isValid = limitedDashboardData.every((category) => {
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
								typeof entry.date === 'string'
						)
				)
			);
		});
		if (!isValid) {
			logger.error('Invalid dashboard data structure after limiting', {
				userId,
				fileName,
				dashboardDataSample: limitedDashboardData.slice(0, 3),
			});
			return res.status(400).json({
				message: 'Invalid dashboard data structure after size limiting.',
			});
		}

		const dashboardDataJson = JSON.stringify(limitedDashboardData);
		const dashboardDataSize = Buffer.byteLength(dashboardDataJson, 'utf8');
		if (dashboardDataSize > maxSizeBytes) {
			logger.error('Dashboard data size still exceeds 8MB after limiting', {
				userId,
				fileName,
				sizeInBytes: dashboardDataSize,
				maxSizeBytes,
			});
			return res.status(400).json({
				message: 'Failed to limit dashboard data to 8MB. Data too large.',
			});
		}
		logger.info('Dashboard data size after limiting', {
			userId,
			fileName,
			sizeInBytes: dashboardDataSize,
			maxSizeBytes,
		});

		const dashboardDataFileId = new mongoose.Types.ObjectId();
		const dashboardDataFilename = `dashboardData-${
			dashboardId || 'new'
		}-${Date.now()}.json`;
		try {
			const writeStream = gfs.openUploadStreamWithId(
				dashboardDataFileId,
				dashboardDataFilename,
				{ contentType: 'application/json', metadata: { userId } }
			);
			writeStream.write(dashboardDataJson);
			writeStream.end();
			await new Promise((resolve, reject) => {
				writeStream.on('finish', resolve);
				writeStream.on('error', reject);
			});
			logger.info('Stored dashboardData in GridFS', {
				userId,
				fileName: dashboardDataFilename,
				fileId: dashboardDataFileId,
				sizeInBytes: dashboardDataSize,
			});
		} catch (gridfsError) {
			logger.error('Failed to store dashboard data in GridFS', {
				userId,
				fileName: dashboardDataFilename,
				error: gridfsError.message,
			});
			return res.status(500).json({
				message: 'Failed to store dashboard data in database.',
			});
		}

		let fileId;
		let isChunked = false;
		const GRIDFS_THRESHOLD = 300 * 1024;
		if (fileBuffer.length > GRIDFS_THRESHOLD) {
			try {
				const writeStream = gfs.openUploadStream(fileName, {
					contentType: fileType,
					metadata: { userId },
				});
				stream.Readable.from(fileBuffer).pipe(writeStream);
				fileId = await new Promise((resolve, reject) => {
					writeStream.on('finish', () => resolve(writeStream.id.toString()));
					writeStream.on('error', reject);
				});
				isChunked = true;
				logger.info('Stored file in GridFS', { userId, fileName, fileId });
			} catch (gridfsError) {
				logger.error('Failed to store file in GridFS', {
					userId,
					fileName,
					error: gridfsError.message,
				});
				return res.status(500).json({
					message: 'Failed to store file in database.',
				});
			}
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

			const dashboardDataJson = JSON.stringify(finalDashboardData);
			const dashboardDataSize = Buffer.byteLength(dashboardDataJson, 'utf8');
			if (dashboardDataSize > maxSizeBytes) {
				logger.error('Merged dashboard data exceeds 8MB limit', {
					userId,
					dashboardId,
					sizeInBytes: dashboardDataSize,
					maxSizeBytes,
				});
				return res
					.status(400)
					.json({ message: 'Merged data exceeds 8MB limit' });
			}

			const newFileId = new mongoose.Types.ObjectId();
			const newFilename = `dashboardData-${dashboardId}-${Date.now()}.json`;
			try {
				const newWriteStream = gfs.openUploadStreamWithId(
					newFileId,
					newFilename,
					{ contentType: 'application/json', metadata: { userId } }
				);
				newWriteStream.write(dashboardDataJson);
				newWriteStream.end();
				await new Promise((resolve, reject) => {
					newWriteStream.on('finish', resolve);
					newWriteStream.on('error', reject);
				});
			} catch (gridfsError) {
				logger.error('Failed to store merged dashboard data in GridFS', {
					userId,
					fileName: newFilename,
					error: gridfsError.message,
				});
				return res.status(500).json({
					message: 'Failed to store merged dashboard data in database.',
				});
			}

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
			: limitedDashboardData; // Only cache dashboardData

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
			} else {
				logger.info('Cached dashboardData in Redis', {
					userId,
					dashboardId: dashboard._id,
					sizeInBytes: Buffer.byteLength(
						JSON.stringify(dashboardDataToCache),
						'utf8'
					),
				});
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboardData', {
				userId,
				dashboardId: dashboard._id,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard data due to server issue';
		}

		try {
			const wasMetadataCached = await Dashboard.cacheDashboardMetadata(
				userId,
				dashboard._id
			);
			if (!wasMetadataCached) {
				logger.warn('Metadata not cached', {
					userId,
					dashboardId: dashboard._id,
				});
			}
		} catch (metaError) {
			logger.warn('Failed to cache dashboard metadata', {
				userId,
				dashboardId: dashboard._id,
				error: metaError.message,
			});
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard processed successfully', {
			userId,
			dashboardId: dashboard._id.toString(),
			fileName,
			fileSize: fileBuffer.length,
			fileType,
			dashboardDataSize,
			duration,
			cacheWarning: cacheWarning || 'Dashboard data cached successfully',
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
				dashboardData: dashboardDataToCache, // Include dashboardData in response
			},
			duration,
			cacheWarning,
		});
	} catch (error) {
		logger.error('Error in createOrUpdateDashboard', {
			userId,
			fileName: req.file?.originalname,
			fileType: req.file?.mimetype,
			fileSize: req.file?.buffer?.length,
			error: error.message,
			stack: error.stack,
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
 * Updates category metadata (e.g., appliedChartType, checkedIds) without storing combinedData or summaryData.
 * @param {Object} req - The request object containing userId, dashboardId, categoryName, and body with appliedChartType and checkedIds.
 * @param {Object} res - The response object.
 * @returns {Promise<void>}
 */
export async function updateCategoryData(req, res) {
	const userId = req.params.userId;
	const dashboardId = req.params.dashboardId;
	const categoryName = decodeURIComponent(req.params.categoryName);

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
			(cat) => cat.categoryName === categoryName
		);
		if (!category) {
			logger.error('Category not found', { categoryName, dashboardId, userId });
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
		const dashboardDataSize = Buffer.byteLength(dashboardDataJson, 'utf8');
		const maxSizeBytes = 8 * 1024 * 1024;
		if (dashboardDataSize > maxSizeBytes) {
			logger.error('Dashboard data exceeds 8MB limit', {
				userId,
				dashboardId,
				sizeInBytes: dashboardDataSize,
				maxSizeBytes,
			});
			return res
				.status(400)
				.json({ message: 'Dashboard data exceeds 8MB limit' });
		}

		const dashboardDataFileId = new mongoose.Types.ObjectId();
		const dashboardDataFilename = `dashboardData-${dashboardId}-${Date.now()}.json`;
		const writeStream = gfs.openUploadStreamWithId(
			dashboardDataFileId,
			dashboardDataFilename,
			{ contentType: 'application/json', metadata: { userId } }
		);
		writeStream.write(dashboardDataJson);
		writeStream.end();
		await new Promise((resolve, reject) => {
			writeStream.on('finish', resolve);
			writeStream.on('error', reject);
		});

		dashboard.dashboardDataRef = {
			fileId: dashboardDataFileId.toString(),
			filename: dashboardDataFilename,
			isChunked: true,
			chunkCount: 1,
			lastUpdate: new Date(),
		};
		await dashboard.save();

		const dashboardDataToCache = dashboardData; // Only cache dashboardData
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
			} else {
				logger.info('Cached dashboardData in Redis', {
					userId,
					dashboardId,
					sizeInBytes: Buffer.byteLength(
						JSON.stringify(dashboardDataToCache),
						'utf8'
					),
				});
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
			categoryName,
			sizeInBytes: dashboardDataSize,
		});
		res
			.status(200)
			.json({ message: 'Category data updated successfully', cacheWarning });
	} catch (error) {
		logger.error('Error updating category data', {
			userId,
			dashboardId,
			categoryName,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}

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
					deleteCachedDashboard(
						userId,
						`dashboard:${userId}:${dashboardId}:data`
					),
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
			} else {
				logger.info('Cached dashboardData in Redis', {
					userId,
					dashboardId,
					sizeInBytes: Buffer.byteLength(JSON.stringify(dashboardData), 'utf8'),
				});
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
		logger.error('Error in getDashboardData controller', {
			userId,
			dashboardId,
			error: error.message,
		});
		res.status(500).json({ message: 'Server error', error: error.message });
	}
}
