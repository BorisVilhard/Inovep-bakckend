import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import xlsx from 'xlsx';
import winston from 'winston';
import Queue from 'bull';
import { Redis } from '@upstash/redis';
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

// Initialize GridFS
let gfs;
mongoose.connection.once('open', () => {
	gfs = new GridFSBucket(mongoose.connection.db, { bucketName: 'Uploads' });
	logger.info('GridFS initialized for MongoDB');
});

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
 * POST /users/:userId/dashboard/upload
 * Creates or updates a dashboard with uploaded CSV or Excel file data.
 * Supports chunked uploads for files >300KB.
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
		const redis = Redis.fromEnv();

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
				return res.status(200).json({
					message: `Chunk ${chunkIndexNum + 1} of ${totalChunksNum} uploaded`,
					chunkIndex: chunkIndexNum,
				});
			}

			const chunks = await redis.lrange(chunkKey, 0, -1);
			fileBuffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
			const fileHash = crypto
				.createHash('md5')
				.update(fileBuffer)
				.digest('hex');
			logger.info('Reassembled file from chunks', {
				userId,
				fileName,
				totalChunks: totalChunksNum,
				totalSize: fileBuffer.length,
				fileHash,
			});

			const debugPath = path.join(
				'/tmp',
				`reassembled-${fileName}-${Date.now()}`
			);
			fs.writeFileSync(debugPath, fileBuffer);
			logger.info('Saved reassembled file for debugging', {
				userId,
				fileName,
				path: debugPath,
			});

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
			const fileHash = crypto
				.createHash('md5')
				.update(fileBuffer)
				.digest('hex');
			logger.info('Non-chunked file', {
				userId,
				fileName,
				fileSize: fileBuffer.length,
				fileHash,
			});
		}

		let sanitizedData;
		if (!validateXlsxStructure(fileBuffer, fileName, userId)) {
			try {
				const workbook = xlsx.read(fileBuffer, {
					type: 'buffer',
					cellDates: true,
				});
				const sheet = workbook.Sheets[workbook.SheetNames[0]];
				let data = xlsx.utils.sheet_to_json(sheet, {
					raw: false,
					defval: null,
				});
				if (!data.length) {
					throw new Error('No data in sheet');
				}
				sanitizedData = sanitizeExcelData(data);
				logger.info('Sanitized Excel data', {
					userId,
					fileName,
					dataLength: sanitizedData.length,
					sampleData: sanitizedData.slice(0, 3),
					columnHeaders: Object.keys(sanitizedData[0] || {}),
				});
				const newSheet = xlsx.utils.json_to_sheet(sanitizedData);
				workbook.Sheets[workbook.SheetNames[0]] = newSheet;
				fileBuffer = xlsx.write(workbook, { bookType: 'xlsx', type: 'buffer' });
			} catch (sanitizeError) {
				logger.error('Failed to sanitize Excel data', {
					userId,
					fileName,
					error: sanitizeError.message,
				});
				return res.status(400).json({
					message:
						'Invalid or corrupted file. Please upload a valid CSV or Excel file with tabular data. Ensure no special characters or macros are present in headers or values.',
				});
			}
		}

		let workbook;
		try {
			workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
		} catch (parseError) {
			logger.error('Failed to parse file', {
				userId,
				fileName,
				fileType,
				error: parseError.message,
			});
			return res.status(400).json({
				message:
					'Invalid or corrupted file. Please upload a valid CSV or Excel file.',
			});
		}

		if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
			logger.error('File has no sheets', { userId, fileName, fileType });
			return res.status(400).json({ message: 'File has no sheets' });
		}
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		if (!sheet) {
			logger.error('Invalid sheet in file', { userId, fileName, fileType });
			return res.status(400).json({ message: 'Invalid sheet in file' });
		}
		const data =
			sanitizedData ||
			xlsx.utils.sheet_to_json(sheet, { raw: false, defval: null });
		if (!data || !Array.isArray(data) || data.length === 0) {
			logger.error('No valid data extracted from file', {
				userId,
				fileName,
				fileType,
			});
			return res.status(400).json({
				message: 'No valid data found in file. Ensure the file contains data.',
			});
		}
		logger.info('File processing details', {
			userId,
			fileName,
			fileType,
			sheetNames: workbook.SheetNames,
			dataLength: data.length,
			sampleData: data.slice(0, 3),
			columnHeaders: Object.keys(data[0] || {}),
		});

		let documentText;
		try {
			documentText = JSON.stringify(data);
			JSON.parse(documentText);
		} catch (jsonError) {
			logger.error('Invalid JSON data from file', {
				userId,
				fileName,
				error: jsonError.message,
			});
			try {
				documentText = sanitizeJsonString(JSON.stringify(data));
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
			logger.error('Invalid dashboard data structure', {
				userId,
				fileName,
				dashboardDataSample: dashboardData.slice(0, 3),
			});
			return res.status(400).json({
				message: 'Invalid dashboard data structure.',
			});
		}

		const dashboardDataJson = JSON.stringify(dashboardData);
		const dashboardDataSize = Buffer.byteLength(dashboardDataJson, 'utf8');
		logger.info('Dashboard data size', {
			userId,
			fileName,
			sizeInBytes: dashboardDataSize,
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
				writeStream.write(fileBuffer);
				writeStream.end();
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
				dashboardData
			);

			const newFileId = new mongoose.Types.ObjectId();
			const newFilename = `dashboardData-${dashboardId}-${Date.now()}.json`;
			try {
				const newWriteStream = gfs.openUploadStreamWithId(
					newFileId,
					newFilename,
					{ contentType: 'application/json', metadata: { userId } }
				);
				newWriteStream.write(JSON.stringify(mergedDashboardData));
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
				const deletionQueue = new Queue('gridfs-deletion', {
					redis: {
						host: process.env.REDIS_HOST || 'crack-vervet-30777.upstash.io',
						port: process.env.REDIS_PORT || 30777,
						password: process.env.UPSTASH_REDIS_TOKEN,
					},
				});
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
		const dashboardObj = {
			...dashboard.toObject(),
			dashboardData: await dashboard.getDashboardData(),
		};

		try {
			const wasCached = await setCachedDashboard(
				userId,
				dashboard._id,
				dashboardObj
			);
			if (!wasCached) {
				cacheWarning = 'Dashboard too large to cache; stored in database only';
			}
		} catch (cacheError) {
			logger.warn('Failed to cache dashboard', {
				userId,
				dashboardId: dashboard._id,
				error: cacheError.message,
			});
			cacheWarning = 'Failed to cache dashboard due to server issue';
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
			cacheWarning: cacheWarning || 'Cached successfully',
		});

		res.status(201).json({
			message: 'Dashboard processed successfully',
			dashboard: dashboardObj,
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
			const redis = Redis.fromEnv();
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

		const result = await Dashboard.deleteDashboardData(dashboardId, userId);

		if (result.modifiedCount === 0) {
			logger.warn('No dashboard data modified (likely not found)', {
				userId,
				dashboardId,
			});
			return res
				.status(404)
				.json({ message: 'Dashboard not found or no data to delete' });
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
				logger.info('Cache cleared after deletion', {
					userId,
					dashboardId,
					attempt,
					cacheCleared,
				});
				break;
			} catch (cacheError) {
				logger.warn('Cache clear attempt failed', {
					userId,
					dashboardId,
					attempt,
					error: cacheError.message,
				});
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
		logger.info('Dashboard data deletion request completed', {
			userId,
			dashboardId,
			modifiedCount: result.modifiedCount,
			queuedFiles: result.queuedFiles,
			cacheCleared,
			duration,
		});

		return res.status(200).json({
			message: 'Dashboard data deleted successfully',
			modifiedCount: result.modifiedCount,
			queuedFiles: result.queuedFiles,
			cacheCleared,
			duration,
		});
	} catch (error) {
		logger.error('Error in deleteDashboardData controller', {
			userId,
			dashboardId,
			error: error.message,
			stack: error.stack,
		});
		return res
			.status(500)
			.json({ message: 'Server error', error: error.message });
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

		const dashboardObj = {
			...dashboard.toObject(),
			dashboardData,
		};

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

		return res.status(200).json({
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
			stack: error.stack,
		});
		return res
			.status(500)
			.json({ message: 'Server error', error: error.message });
	}
}
