import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import xlsx from 'xlsx';
import winston from 'winston';
import Queue from 'bull';
import { Redis } from '@upstash/redis';
import Papa from 'papaparse';
import zlib from 'zlib';
import Dashboard from '../model/Data.js';
import {
	setCachedDashboard,
	getCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';
import {
	calculateDynamicParameters,
	getNumericTitles,
	mergeDashboardData,
	limitDashboardDataSize,
	getDateTitles,
} from '../utils/dashboardUtils.js';
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

let gfs;
mongoose.connection.once('open', () => {
	gfs = new GridFSBucket(mongoose.connection.db, { bucketName: 'Uploads' });
	logger.info('GridFS initialized');
});

const redis = Redis.fromEnv();
const deletionQueue = new Queue('gridfs-deletion', {
	redis: {
		url: process.env.UPSTASH_REDIS_REST_URL,
		token: process.env.UPSTASH_REDIS_REST_TOKEN,
	},
});

// Valid chart types
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

// Validate authentication token (stub; replace with actual middleware)
function validateAuth(authHeader) {
	logger.debug('Validating auth header', { authHeader });
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		logger.warn('Missing or invalid Authorization header', { authHeader });
		return false;
	}
	const token = authHeader.split(' ')[1];
	logger.debug('Token extracted', { token: token ? 'present' : 'missing' });
	return !!token; // Replace with actual JWT validation
}

// Sanitize JSON string
function sanitizeJsonString(s) {
	return s
		.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
		.replace(/[\uFFFD]/g, '')
		.replace(/[^\x20-\x7E\t\n\r]/g, '')
		.replace(/([{,]\s*)(\w+)(?=\s*:)/g, '$1"$2"')
		.replace(/:\s*([^,\]}]+)(?=[,\]}])/g, (m, p1) => {
			if (/[^0-9.\-]/.test(p1.trim())) {
				return `: "${p1.trim().replace(/"/g, '\\"')}"`;
			}
			return m;
		});
}

// Sanitize key for JSON
function sanitizeKey(k) {
	return (
		k
			.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
			.replace(/[^\w\s-]/g, '')
			.replace(/\s+/g, '_')
			.replace(/^\d/, '_$&')
			.trim() || 'unk_col'
	);
}

// Validate XLSX structure
function validateXlsxStructure(b, fn, uid) {
	try {
		const xlsxMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
		if (!b.slice(0, 4).equals(xlsxMagic)) {
			logger.error('Invalid XLSX: Not a ZIP file', {
				uid,
				fn,
				magic: b.slice(0, 4).toString('hex'),
			});
			return {
				valid: false,
				error: 'Not a valid XLSX file (invalid ZIP format)',
			};
		}

		const wb = xlsx.read(b, {
			type: 'buffer',
			cellDates: true,
			raw: false,
			cellText: false,
		});
		if (!wb.SheetNames.length) {
			logger.error('Invalid XLSX: No sheets found', { uid, fn });
			return { valid: false, error: 'No sheets found in Excel file' };
		}

		const sn =
			wb.SheetNames.find((n) => n.toLowerCase().includes('sheet')) ||
			wb.SheetNames[0];
		const sheet = wb.Sheets[sn];
		if (!sheet) {
			logger.error('Invalid XLSX: Sheet not accessible', {
				uid,
				fn,
				sheetName: sn,
			});
			return { valid: false, error: `Sheet '${sn}' not accessible` };
		}

		const data = xlsx.utils.sheet_to_json(sheet, {
			raw: false,
			defval: null,
			header: 1,
		});
		logger.info('Extracted XLSX data', {
			uid,
			entries: data.length,
			sheetName: sn,
		});

		if (data.length > 0) {
			data.slice(0, 5).forEach((row, i) => {
				if (Array.isArray(row)) {
					const invalid = row
						.filter(
							(v) =>
								v !== null &&
								typeof v === 'string' &&
								/[\x00-\x1F\x7F-\x9F]/.test(v)
						)
						.map((v) => ({ v: v.substring(0, 50), index: i }));
					if (invalid.length) {
						logger.warn('Control chars detected in row', {
							uid,
							fn,
							row: i,
							invalid,
						});
					}
				}
			});
		} else {
			logger.warn('No data rows detected', { uid, fn });
			return {
				valid: true,
				error: 'Warning: No data rows found, but file is valid',
			};
		}

		return { valid: true };
	} catch (e) {
		logger.error('Failed to validate XLSX', {
			uid,
			fn,
			error: e.message,
			bufferSample: b.slice(0, 100).toString('hex'),
		});
		return { valid: false, error: `Parsing error: ${e.message}` };
	}
}

// Sanitize Excel data
function sanitizeExcelData(data) {
	return data.map((row) => {
		const sanitized = {};
		Object.entries(row).forEach(([key, value]) => {
			const sanitizedKey = sanitizeKey(key);
			sanitized[sanitizedKey] =
				value !== null && typeof value === 'string'
					? value.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
					: value;
		});
		return sanitized;
	});
}

// Parse Excel stream
async function parseExcelStream(buffer, callback) {
	const workbook = xlsx.read(buffer, {
		type: 'buffer',
		cellDates: true,
		raw: false,
		cellText: false,
	});
	const sheetName =
		workbook.SheetNames.find((name) => name.toLowerCase().includes('sheet')) ||
		workbook.SheetNames[0];
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
		callback(batch);
		await new Promise((resolve) => setTimeout(resolve, 0));
		logger.info(`Processed ${data.length} rows`, { fileName: sheetName });
	}
	return data;
}

// Parse CSV buffer
function parseCsv(buffer) {
	return new Promise((resolve, reject) => {
		Papa.parse(buffer.toString(), {
			header: true,
			chunkSize: 1000,
			step: (results) =>
				logger.info(`Processed CSV chunk`, { rows: results.data.length }),
			complete: (results) => resolve(results.data),
			error: (error) => reject(error),
		});
	});
}

// Write to GridFS
async function writeToGridFS(fileId, filename, data, contentType, metadata) {
	const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
	const compressed =
		contentType === 'application/json' ? zlib.gzipSync(buffer) : buffer;
	const writeStream = gfs.openUploadStreamWithId(
		mongoose.Types.ObjectId(fileId),
		filename,
		{
			contentType,
			metadata: { ...metadata, compressed: contentType === 'application/json' },
		}
	);
	writeStream.write(compressed);
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
	const authHeader = req.headers.authorization;
	logger.debug('Received upload request', {
		userId: req.params.userId,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const uid = req.params.userId;
	const start = Date.now();
	let chunkKey;

	try {
		if (!mongoose.Types.ObjectId.isValid(uid)) {
			logger.error('Invalid userId', { uid });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid userId' });
		}

		const {
			id,
			name,
			chunkIdx,
			totalChunks,
			parameters,
			operations,
			resultName,
		} = req.body;
		const file = req.file;
		if (!file) {
			logger.error('No file uploaded', { uid });
			return res.status(400).json({ msg: 'No file uploaded' });
		}

		let fileType = file.mimetype;
		let fileName = file.originalname;
		logger.info('Processing file', {
			uid,
			fileName,
			fileType,
			size: file.buffer.length,
			chunkIdx,
			totalChunks,
		});

		// Handle "blob" filename by using dashboardName or default
		if (fileName === 'blob' || !fileName.match(/\.(csv|xlsx|xls)$/i)) {
			const dashboardName = name || `upload-${Date.now()}`;
			const inferredExtension = fileType == 'numeric' ? '.csv' : '.xlsx';
			fileName = `${dashboardName}${inferredExtension}`;
			logger.warn('Corrected invalid filename', {
				uid,
				originalName: file.originalname,
				newName: fileName,
			});
		}

		let fileBuffer;
		const MAX_CHUNK_SIZE = 500 * 1024; // 500 KB
		const MAX_FILE_SIZE = 6 * 1024 * 1024; // 6MB
		chunkKey = `chunk:${uid}:${id || 'new'}:${fileName}`;

		if (totalChunks && chunkIdx !== undefined) {
			const chunkIndex = parseInt(chunkIdx, 10);
			const totalChunksCount = parseInt(totalChunks, 10);

			if (
				isNaN(chunkIndex) ||
				isNaN(totalChunksCount) ||
				chunkIndex >= totalChunksCount ||
				chunkIndex < 0
			) {
				logger.error('Invalid chunk parameters', {
					uid,
					chunkIdx,
					totalChunks,
				});
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_CHUNK: Invalid chunk parameters' });
			}

			if (file.buffer.length > MAX_CHUNK_SIZE) {
				logger.error('Chunk size exceeds max', {
					uid,
					fileName,
					chunkIdx: chunkIndex,
				});
				return res.status(400).json({ msg: 'Chunk size exceeds 500KB' });
			}

			await redis.rpush(chunkKey, file.buffer.toString('base64'));
			logger.info('Stored chunk', {
				uid,
				fileName,
				chunkIdx: chunkIndex,
				totalChunks: totalChunksCount,
				size: file.buffer.length,
			});

			if (chunkIndex < totalChunksCount - 1) {
				const progress = ((chunkIndex + 1) / totalChunksCount) * 100;
				return res.status(200).json({
					msg: `Chunk ${chunkIndex + 1} of ${totalChunksCount} uploaded`,
					chunkIdx: chunkIndex,
					totalChunks: totalChunksCount,
					progress: progress.toFixed(2),
				});
			}

			const chunks = await redis.lrange(chunkKey, 0, -1);
			fileBuffer = Buffer.concat(
				chunks.map((chunk) => Buffer.from(chunk, 'base64'))
			);
			await redis.del(chunkKey);

			if (fileBuffer.length > MAX_FILE_SIZE) {
				logger.error('File size exceeds max', {
					uid,
					fileName,
					size: fileBuffer.length,
				});
				return res.status(400).json({ msg: 'File size exceeds 6MB' });
			}

			// Validate reassembled file content
			if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
				const validation = validateXlsxStructure(fileBuffer, fileName, uid);
				if (!validation.valid) {
					logger.error('Invalid reassembled XLSX file', {
						uid,
						fileName,
						details: validation.error,
					});
					return res.status(400).json({
						msg: 'Invalid XLSX structure in reassembled file',
						details: validation.error,
					});
				}
				fileType =
					'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
			} else if (fileName.endsWith('.csv')) {
				try {
					await parseCsv(fileBuffer);
				} catch (e) {
					logger.error('Invalid reassembled CSV file', {
						uid,
						fileName,
						error: e.message,
					});
					return res.status(400).json({
						msg: 'Invalid CSV structure in reassembled file',
					});
				}
				fileType = 'text/csv';
			} else {
				logger.error('Unsupported reassembled file type', {
					uid,
					fileName,
					extension: fileName.toLowerCase().match(/\.[^\.]+$/)?.[0] || '',
				});
				return res.status(400).json({ msg: 'Unsupported file type' });
			}

			logger.debug('Reassembled buffer validated', {
				uid,
				fileName,
				size: fileBuffer.length,
				fileType,
				sample: fileBuffer.slice(0, 100).toString('hex'),
			});
		} else {
			fileBuffer = file.buffer;
		}

		let rawData = [];
		const onBatch = (batch) => {
			rawData.push(...batch);
			logger.info(`Processed ${batch.length} rows`, { uid, fileName });
		};

		if (fileName.endsWith('.csv')) {
			rawData = await parseCsv(fileBuffer);
		} else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
			const validation = validateXlsxStructure(fileBuffer, fileName, uid);
			if (!validation.valid) {
				logger.error('XLSX validation failed', {
					uid,
					fileName,
					details: validation.error,
				});
				return res.status(400).json({
					msg: 'Invalid XLSX structure',
					details: validation.error || 'Failed to parse Excel file',
				});
			}
			rawData = await parseExcelStream(fileBuffer, onBatch);
			rawData = sanitizeExcelData(rawData);
		} else {
			return res.status(400).json({ msg: 'Unsupported file type' });
		}

		if (!Array.isArray(rawData) || rawData.length === 0) {
			logger.error('No valid data extracted', { uid, fileName });
			return res
				.status(400)
				.json({ msg: 'ERR_NO_DATA: No valid data extracted from file' });
		}

		let dataString;
		try {
			dataString = JSON.stringify(rawData);
			JSON.parse(dataString);
		} catch (e) {
			try {
				dataString = sanitizeJsonString(JSON.stringify(rawData));
				JSON.parse(dataString);
			} catch (err) {
				logger.error('Failed to sanitize JSON', {
					uid,
					fileName,
					error: err.message,
				});
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_DATA: Invalid or corrupted data' });
			}
		}

		const responseCode = transformExcelDataToJSCode(dataString);
		const extractedData = extractJavascriptCode(responseCode);
		let { dashboardData } = transformDataStructure(extractedData, fileName);

		if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
			logger.error('No valid dashboard data', { uid, fileName });
			return res
				.status(400)
				.json({ msg: 'ERR_NO_DATA: No valid dashboard data extracted' });
		}

		// Convert date strings to Date objects
		dashboardData = dashboardData.map((category) => ({
			...category,
			data: category.data.map((entry) => ({
				...entry,
				d: entry.d.map((node) => ({
					...node,
					d:
						typeof node.d === 'string' && /\d{4}-\d{2}-\d{2}T/.test(node.d)
							? new Date(node.d)
							: node.d,
				})),
			})),
		}));

		// Apply summation of Weight_kg and Height_cm
		const sumParameters = ['Weight_kg', 'Height_cm'];
		const sumOperation = ['plus'];
		const sumResultName = 'result';
		dashboardData = calculateDynamicParameters(
			dashboardData,
			sumParameters,
			sumOperation,
			sumResultName
		);

		// Identify numeric parameters for validation
		const numericParameters = getNumericTitles(dashboardData);

		// Apply additional dynamic parameter calculation if provided
		if (parameters && operations && resultName) {
			if (!parameters.every((p) => numericParameters.includes(p))) {
				logger.error('Selected parameters are not all numeric', {
					uid,
					parameters,
				});
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_PARAM: Parameters must be numeric' });
			}
			dashboardData = calculateDynamicParameters(
				dashboardData,
				parameters,
				operations,
				resultName
			);
		}

		const maxSize = 8 * 1024 * 1024;
		const limitedData = limitDashboardDataSize(dashboardData, maxSize);

		const isValid = limitedData.every(
			(category) =>
				typeof category.cat === 'string' &&
				Array.isArray(category.data) &&
				category.data.every(
					(entry) =>
						typeof entry.i === 'string' &&
						Array.isArray(entry.d) &&
						entry.d.every(
							(node) =>
								typeof node.t === 'string' &&
								node.v !== undefined &&
								node.d instanceof Date
						)
				)
		);
		if (!isValid) {
			logger.error('Invalid dashboard data structure', {
				uid,
				fileName,
				limitedDataSample: JSON.stringify(limitedData.slice(0, 1)),
			});
			return res.status(400).json({
				msg: 'ERR_INVALID_STRUCTURE: Invalid dashboard data structure',
			});
		}

		const dashboardJson = JSON.stringify(limitedData);
		const dataFileId = new mongoose.Types.ObjectId();
		const dataFileName = `data-${id || 'new'}-${Date.now()}.json`;
		await writeToGridFS(
			dataFileId,
			dataFileName,
			dashboardJson,
			'application/json',
			{ uid }
		);

		let fileId;
		let isChunked = false;
		const GRIDFS_THRESHOLD = 300 * 1024;
		if (fileBuffer.length > GRIDFS_THRESHOLD) {
			fileId = new mongoose.Types.ObjectId();
			await writeToGridFS(fileId, fileName, fileBuffer, fileType, { uid });
			isChunked = true;
		}

		const fileData = {
			fid: fileId || new mongoose.Types.ObjectId().toString(),
			fn: fileName,
			c: isChunked ? undefined : fileBuffer,
			src: 'local',
			ch: isChunked,
			cc: totalChunks ? parseInt(totalChunks, 10) : 1,
			lu: new Date(),
			mon: { s: 'active' },
		};

		const dataRef = {
			fid: dataFileId.toString(),
			fn: dataFileName,
			ch: true,
			cc: 1,
			lu: new Date(),
		};

		let dashboard;
		if (id) {
			if (!mongoose.Types.ObjectId.isValid(id)) {
				logger.error('Invalid dashboard ID', { uid, id });
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_ID: Invalid dashboard ID' });
			}

			dashboard = await Dashboard.findOne({ _id: id, uid });
			if (!dashboard) {
				logger.error('Dashboard not found', { uid, id });
				return res
					.status(404)
					.json({ msg: `ERR_NOT_FOUND: Dashboard ID ${id} not found` });
			}

			const existingData = await Promise.race([
				dashboard.getDashboardData(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error('Database query timeout')), 5000)
				),
			]);
			const mergedData = mergeDashboardData(existingData, limitedData);
			const finalData = limitDashboardDataSize(mergedData, maxSize);

			const finalJson = JSON.stringify(finalData);
			if (Buffer.byteLength(finalJson, 'utf8') > maxSize) {
				logger.error('Merged data exceeds 8MB', { uid, id });
				return res
					.status(400)
					.json({ msg: 'ERR_SIZE_LIMIT: Merged data exceeds 8MB' });
			}

			const newFileId = new mongoose.Types.ObjectId();
			const newFileName = `data-${id}-${Date.now()}.json`;
			await writeToGridFS(
				newFileId,
				newFileName,
				finalJson,
				'application/json',
				{ uid }
			);

			if (dashboard.ref?.fid) {
				await deletionQueue.add(
					{ fileIds: [dashboard.ref.fid] },
					{ attempts: 3 }
				);
			}

			dashboard.ref = {
				fid: newFileId.toString(),
				fn: newFileName,
				ch: true,
				cc: 1,
				lu: new Date(),
			};
			dashboard.f.push(fileData);
		} else if (name) {
			const exists = await Dashboard.findOne({ name, uid }).lean();
			if (exists) {
				logger.error('Dashboard name exists', { uid, name });
				return res
					.status(400)
					.json({ msg: 'ERR_NAME_EXISTS: Dashboard name exists' });
			}
			dashboard = new Dashboard({
				name,
				ref: dataRef,
				f: [fileData],
				uid,
			});
		} else {
			logger.error('ID or name required', { uid });
			return res
				.status(400)
				.json({ msg: 'ERR_MISSING_PARAM: ID or name required' });
		}

		await dashboard.save();
		const cacheData = id ? finalData : limitedData;
		let cacheWarning = null;

		try {
			const cacheKey = `dash:${uid}:${dashboard._id}:data`;
			const cached = await setCachedDashboard(uid, cacheKey, cacheData);
			if (!cached) {
				cacheWarning = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, dashboard._id);
		} catch (e) {
			logger.warn('Failed to cache data', {
				uid,
				id: dashboard._id,
				error: e.message,
			});
			cacheWarning = 'Cache failed due to server issue';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard processed', {
			uid,
			id: dashboard._id,
			fileName,
			duration,
		});

		res.status(201).json({
			msg: 'Dashboard processed',
			dashboard: {
				_id: dashboard._id,
				name: dashboard.name,
				ref: dashboard.ref,
				f: dashboard.f,
				uid: dashboard.uid,
				ca: dashboard.ca,
				ua: dashboard.ua,
				data: cacheData,
			},
			duration,
			cacheWarning,
			numericParameters,
		});
	} catch (e) {
		logger.error('Error in createOrUpdateDashboard', {
			uid,
			fileName: req.file?.originalname,
			error: e.message,
			stack: e.stack,
		});
		if (chunkKey) {
			await redis
				.del(chunkKey)
				.catch((err) =>
					logger.error('Failed to clean Redis', { error: err.message })
				);
		}
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * DELETE /users/:userId/dashboard/:dashboardId
 * Deletes a dashboard and its associated data.
 */
export async function deleteDashboardData(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received delete dashboard request', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		const dashboard = await Dashboard.findOne({ _id: id, uid });
		if (!dashboard) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const fileIds = [
			dashboard.ref?.fid,
			...dashboard.f.map((file) => file.fid),
		].filter((fid) => mongoose.Types.ObjectId.isValid(fid));

		if (fileIds.length > 0) {
			await deletionQueue.add({ fileIds }, { attempts: 3 });
		}

		await Dashboard.deleteOne({ _id: id, uid });
		await deleteCachedDashboard(uid, `dash:${uid}:${id}:data`);
		await deleteCachedDashboard(uid, `dash:${uid}:all`);

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard deleted', {
			uid,
			id,
			queuedFiles: fileIds.length,
			duration,
		});

		res.status(200).json({
			msg: 'Dashboard deleted',
			modifiedCount: 1,
			queuedFiles: fileIds.length,
			duration,
		});
	} catch (e) {
		logger.error('Error in deleteDashboardData', {
			uid,
			id,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /users/:userId/dashboards
 * Retrieves all dashboards for a user.
 */
export async function getAllDashboards(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received get all dashboards request', {
		userId: req.params.userId,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid } = req.params;
	const start = Date.now();

	try {
		if (!mongoose.Types.ObjectId.isValid(uid)) {
			logger.error('Invalid uid', { uid });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid' });
		}

		const cacheKey = `dash:${uid}:all`;
		const cachedData = await getCachedDashboard(uid, cacheKey);
		if (cachedData) {
			const duration = (Date.now() - start) / 1000;
			logger.info('Retrieved all dashboards from cache', {
				uid,
				count: cachedData.length,
				duration,
			});
			return res.status(200).json({
				msg: 'Dashboards retrieved',
				dashboards: cachedData.map((d) => ({ ...d, data: [] })),
				duration,
			});
		}

		const dashboards = await Dashboard.find(
			{ uid },
			{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
		).lean();

		// Add empty data array to each dashboard
		const dashboardsWithData = dashboards.map((d) => ({ ...d, data: [] }));

		let cacheWarning = null;
		try {
			const cached = await setCachedDashboard(
				uid,
				cacheKey,
				dashboardsWithData
			);
			if (!cached) {
				cacheWarning = 'Data too large to cache';
			}
		} catch (e) {
			logger.warn('Failed to cache dashboards', { uid, error: e.message });
			cacheWarning = 'Cache failed';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved all dashboards from DB', {
			uid,
			count: dashboards.length,
			duration,
		});

		res.status(200).json({
			msg: 'Dashboards retrieved',
			dashboards: dashboardsWithData,
			duration,
			cacheWarning,
		});
	} catch (e) {
		logger.error('Error in getAllDashboards', {
			uid,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * PUT /users/:userId/dashboard/:dashboardId/category/:categoryName
 * Updates a specific category's chart type or IDs.
 */
export async function updateCategoryData(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received update category request', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		categoryName: req.params.categoryName,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id, categoryName: cn } = req.params;
	const decodedCategoryName = decodeURIComponent(cn);
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		const dashboard = await Dashboard.findOne({ _id: id, uid });
		if (!dashboard) {
			logger.error('Dashboard not found', { id, uid });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const category = (await dashboard.getDashboardData()).find(
			(c) => c.cat === decodedCategoryName
		);
		if (!category) {
			logger.error('Category not found', {
				category: decodedCategoryName,
				id,
				uid,
			});
			return res.status(404).json({ msg: 'ERR_NOT_FOUND: Category not found' });
		}

		const { chart, ids } = req.body;
		if (chart && !validChartTypes.includes(chart)) {
			logger.error('Invalid chart type', { chart, uid, id });
			return res
				.status(400)
				.json({ msg: 'ERR_INVALID_CHART: Invalid chart type' });
		}

		if (chart) category.chart = chart;
		if (Array.isArray(ids)) category.ids = ids;

		const dashboardData = await dashboard.getDashboardData();
		const dashboardJson = JSON.stringify(dashboardData);
		const maxSize = 8 * 1024 * 1024;
		if (Buffer.byteLength(dashboardJson, 'utf8') > maxSize) {
			logger.error('Data exceeds 8MB', { uid, id });
			return res
				.status(400)
				.json({ msg: 'ERR_SIZE_LIMIT: Data exceeds maxSize' });
		}

		const dataFileId = new mongoose.Types.ObjectId();
		const dataFileName = `data-${id}-${Date.now()}.json`;
		await writeToGridFS(
			dataFileId,
			dataFileName,
			dashboardJson,
			'application/json',
			{ uid }
		);

		dashboard.ref = {
			fid: dataFileId.toString(),
			fn: dataFileName,
			ch: true,
			cc: 1,
			lu: new Date(),
		};
		await dashboard.save();

		let cacheWarning = null;
		try {
			const cacheKey = `dash:${uid}:${dashboard._id}:data`;
			const cached = await setCachedDashboard(uid, cacheKey, dashboardData);
			if (!cached) {
				cacheWarning = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, id);
		} catch (e) {
			logger.warn('Failed to cache data', { uid, id, error: e.message });
			cacheWarning = 'Cache failed';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Updated category', {
			uid,
			id,
			category: decodedCategoryName,
			duration,
		});
		res.status(200).json({ msg: 'Category updated', duration, cacheWarning });
	} catch (e) {
		logger.error('Error updating category', {
			uid,
			id,
			category: decodedCategoryName,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId/file/:fileId
 * Downloads a file associated with a dashboard.
 */
export async function downloadDashboardFile(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received download file request', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		fileId: req.params.fileId,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id, fileId: fid } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id) ||
			!mongoose.Types.ObjectId.isValid(fid)
		) {
			logger.error('Invalid uid, id, or fid', { uid, id, fid });
			return res
				.status(400)
				.json({ msg: 'ERR_INVALID_ID: Invalid uid, id, or fid' });
		}

		const dashboard = await Dashboard.findOne({ _id: id, uid }).lean();
		if (!dashboard) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const fileData = dashboard.f.find((file) => file.fid === fid);
		if (!fileData) {
			logger.warn('File not found', { uid, id, fid });
			return res.status(404).json({ msg: 'ERR_NOT_FOUND: File not found' });
		}

		if (!fileData.ch) {
			res.set({
				'Content-Type': fileData.contentType || 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${fileData.fn}"`,
			});
			res.send(fileData.c);
			const duration = (Date.now() - start) / 1000;
			logger.info('Served non-chunked file', { uid, id, fid, duration });
			return;
		}

		const downloadStream = gfs.openDownloadStream(
			new mongoose.Types.ObjectId(fid)
		);
		res.set({
			'Content-Type': fileData.contentType || 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${fileData.fn}"`,
		});
		downloadStream.pipe(res);

		downloadStream.on('error', (e) => {
			logger.error('Error streaming file', { uid, id, fid, error: e.message });
			if (!res.headersSent) {
				res.status(500).json({ msg: 'ERR_SERVER: Error streaming file' });
			}
		});

		downloadStream.on('end', () => {
			const duration = (Date.now() - start) / 1000;
			logger.info('File download completed', { uid, id, fid, duration });
		});
	} catch (e) {
		logger.error('Error in downloadDashboardFile', {
			uid,
			id,
			fid,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}
/**
 * GET /users/:userId/dashboard/:dashboardId
 * Retrieves dashboard data from cache or database.
 */
export async function getDashboardData(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received get dashboard request', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		authHeader: !!authHeader,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		const cacheKey = `dash:${uid}:${id}:data`;
		let cachedData = null;
		try {
			const cacheRaw = await getCachedDashboard(uid, cacheKey);
			if (cacheRaw && Array.isArray(cacheRaw)) {
				cachedData = cacheRaw;
				logger.debug('Cache hit', {
					uid,
					id,
					dataSample: JSON.stringify(cachedData.slice(0, 1)),
				});
			} else if (cacheRaw) {
				logger.warn('Invalid cache data, clearing cache', { uid, id });
				await deleteCachedDashboard(uid, cacheKey);
			}
		} catch (cacheError) {
			logger.warn('Failed to retrieve cache, falling back to database', {
				uid,
				id,
				error: cacheError.message,
			});
		}

		if (cachedData) {
			const dashboard = await Dashboard.findOne(
				{ _id: id, uid },
				{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
			).lean();
			if (!dashboard) {
				logger.warn('Dashboard not found', { uid, id });
				return res
					.status(404)
					.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
			}
			const numericParameters = getNumericTitles(cachedData);
			const dateParameters = getDateTitles(cachedData);
			const duration = (Date.now() - start) / 1000;
			logger.info('Retrieved from cache', { uid, id, duration });
			return res.status(200).json({
				msg: 'Dashboard retrieved',
				dashboard: { ...dashboard, data: cachedData },
				numericParameters,
				dateParameters,
				duration,
			});
		}

		const dashboard = await Dashboard.findOne(
			{ _id: id, uid },
			{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
		).lean();
		if (!dashboard) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const downloadStream = gfs.openDownloadStream(
			new mongoose.Types.ObjectId(dashboard.ref.fid)
		);
		let data = Buffer.alloc(0);
		downloadStream.on('data', (chunk) => {
			data = Buffer.concat([data, chunk]);
		});
		await new Promise((resolve, reject) => {
			downloadStream.on('end', resolve);
			downloadStream.on('error', reject);
		});

		let dashboardData;
		try {
			let dataString;
			// Check for gzip compression
			if (data[0] === 0x1f && data[1] === 0x8b) {
				logger.debug('Decompressing GridFS data', { uid, id });
				try {
					dataString = zlib.gunzipSync(data).toString('utf8');
				} catch (decompressError) {
					logger.error('Failed to decompress GridFS data', {
						uid,
						id,
						error: decompressError.message,
					});
					throw new Error('Corrupted compressed data');
				}
			} else {
				dataString = data.toString('utf8');
			}

			// Validate JSON format
			if (!dataString.trim().startsWith('[')) {
				throw new Error('Invalid JSON format: Data does not start with array');
			}

			dashboardData = JSON.parse(dataString, (key, value) => {
				if (
					key === 'd' &&
					typeof value === 'string' &&
					/\d{4}-\d{2}-\d{2}T/.test(value)
				) {
					return new Date(value);
				}
				if (key === 'v' && typeof value === 'string' && !isNaN(Number(value))) {
					return Number(value); // Convert numeric strings to numbers
				}
				return value;
			});

			// Validate data structure
			if (!Array.isArray(dashboardData)) {
				throw new Error('Invalid data structure: Not an array');
			}
			dashboardData.forEach((category, index) => {
				if (typeof category.cat !== 'string' || !Array.isArray(category.data)) {
					throw new Error(`Invalid category at index ${index}`);
				}
				category.data.forEach((entry, entryIndex) => {
					if (
						typeof entry.i !== 'string' ||
						!Array.isArray(entry.d) ||
						!entry.d.every(
							(node) =>
								typeof node.t === 'string' &&
								node.v !== undefined &&
								node.d instanceof Date
						)
					) {
						throw new Error(
							`Invalid entry at category ${index}, entry ${entryIndex}`
						);
					}
				});
			});
		} catch (parseError) {
			logger.error('Failed to parse GridFS data', {
				uid,
				id,
				error: parseError.message,
				dataSample: data.slice(0, 50).toString('hex'),
			});
			try {
				await deleteCachedDashboard(uid, cacheKey);
				logger.info('Cleared corrupted cache', { uid, key: cacheKey });
			} catch (clearError) {
				logger.warn('Failed to clear cache', {
					uid,
					id,
					error: clearError.message,
				});
			}
			return res.status(500).json({
				msg: 'ERR_SERVER: Invalid or corrupted dashboard data',
				error: parseError.message,
			});
		}

		let cacheWarning = null;
		try {
			const cached = await setCachedDashboard(uid, cacheKey, dashboardData);
			if (!cached) {
				cacheWarning = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, id);
		} catch (cacheError) {
			logger.warn('Failed to cache data', {
				uid,
				id,
				error: cacheError.message,
			});
			cacheWarning = 'Cache failed';
		}

		const numericParameters = getNumericTitles(dashboardData);
		const dateParameters = getDateTitles(dashboardData);
		const dashboardObject = { ...dashboard, data: dashboardData };

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved from DB', {
			uid,
			id,
			categories: dashboardData.length,
			duration,
		});

		res.status(200).json({
			msg: 'Dashboard retrieved',
			dashboard: dashboardObject,
			numericParameters,
			dateParameters,
			duration,
			cacheWarning,
		});
	} catch (e) {
		logger.error('Error in getDashboardData', {
			uid,
			id,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * Calculates a dynamic result from user-specified parameters and operations.
 * Removes used parameters and adds result to each category's data array.
 * Handles numeric calculations, date differences, and string concatenation.
 * Ensures `d` fields are Date objects to pass validation.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
export async function calculateDashboardParameters(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received calculate parameters request', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		authHeader: !!authHeader,
		parameters: req.body.parameters,
		operations: req.body.operations,
		resultName: req.body.resultName,
		calculationType: req.body.calculationType,
	});
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const {
		parameters,
		operations,
		resultName,
		calculationType = 'numeric',
	} = req.body;
	const start = Date.now();

	try {
		// Validate IDs
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid id' });
		}

		// Validate input
		if (!Array.isArray(parameters) || parameters.length < 2) {
			logger.error('Invalid parameters: at least two required', {
				uid,
				id,
				parameters,
			});
			return res
				.status(400)
				.json({ msg: 'ERR_INVALID_INPUT: At least two parameters required' });
		}

		if (
			!Array.isArray(operations) ||
			(calculationType === 'numeric' &&
				operations.length !== parameters.length - 1) ||
			(calculationType === 'date' &&
				(parameters.length !== 2 || operations[0] !== 'minus'))
		) {
			logger.error('Invalid operations', {
				uid,
				id,
				operations,
				calculationType,
				expected:
					calculationType === 'numeric' ? parameters.length - 1 : 'minus',
			});
			return res.status(400).json({
				msg: 'ERR_INVALID_INPUT: Invalid operations for calculation type',
			});
		}

		if (typeof resultName !== 'string' || !resultName.trim()) {
			logger.error('Invalid resultName: must be a non-empty string', {
				uid,
				id,
				resultName,
			});
			return res.status(400).json({
				msg: 'ERR_INVALID_INPUT: Result name must be a non-empty string',
			});
		}

		const validOperations =
			calculationType === 'numeric'
				? ['plus', 'minus', 'multiply', 'divide']
				: ['minus'];
		if (!operations.every((op) => validOperations.includes(op))) {
			logger.error('Invalid operation', {
				uid,
				id,
				operations,
				calculationType,
			});
			return res.status(400).json({
				msg: `ERR_INVALID_OPERATION: Operations must be ${validOperations.join(
					', '
				)}`,
			});
		}

		// Find dashboard
		const dashboard = await Dashboard.findOne({ _id: id, uid });
		if (!dashboard) {
			logger.error('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		// Retrieve existing dashboard data
		logger.debug('Fetching dashboard data', { uid, id });
		let dashboardData = await Promise.race([
			dashboard.getDashboardData(),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Database query timeout')), 5000)
			),
		]);
		logger.debug('Dashboard data retrieved', {
			uid,
			id,
			categoryCount: dashboardData.length,
			sample: JSON.stringify(dashboardData.slice(0, 1)),
		});

		// Validate dashboardData
		if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
			logger.error('No valid dashboard data', { uid, id });
			return res
				.status(400)
				.json({ msg: 'ERR_NO_DATA: No valid dashboard data available' });
		}

		// Convert d fields to Date objects and v fields to numbers where applicable
		dashboardData = dashboardData.map((category) => ({
			...category,
			data: Array.isArray(category.data)
				? category.data.map((entry) => ({
						...entry,
						d: Array.isArray(entry.d)
							? entry.d.map((node) => {
									const dValue = node.d;
									const vValue = node.v;
									const dType = typeof dValue;
									const vType = typeof vValue;
									const isDate = dValue instanceof Date;
									const isValidString =
										typeof dValue === 'string' &&
										/\d{4}-\d{2}-\d{2}T/.test(dValue);
									const isNumericString =
										typeof vValue === 'string' && !isNaN(Number(vValue));
									logger.debug('Field analysis', {
										uid,
										id,
										cat: category.cat,
										entry: entry.i,
										dValue,
										dType,
										vValue,
										vType,
										isDate,
										isValidString,
										isNumericString,
									});
									return {
										...node,
										d: isDate
											? dValue
											: isValidString
											? new Date(dValue)
											: new Date(),
										v: isNumericString ? Number(vValue) : vValue,
									};
							  })
							: [],
				  }))
				: [],
		}));

		// Validate initial dashboardData structure
		const isValidInitialStructure = dashboardData.every(
			(category) =>
				typeof category.cat === 'string' &&
				Array.isArray(category.data) &&
				category.data.every(
					(entry) =>
						typeof entry.i === 'string' &&
						Array.isArray(entry.d) &&
						entry.d.every(
							(node) =>
								typeof node.t === 'string' &&
								node.v !== undefined &&
								node.d instanceof Date
						)
				)
		);
		if (!isValidInitialStructure) {
			logger.error('Invalid initial dashboard data structure', {
				uid,
				id,
				sample: JSON.stringify(dashboardData.slice(0, 1)),
			});
			return res.status(400).json({
				msg: 'ERR_INVALID_STRUCTURE: Invalid initial dashboard data structure',
			});
		}

		// Validate parameters based on calculation type
		const validTitles =
			calculationType === 'numeric'
				? getNumericTitles(dashboardData)
				: getDateTitles(dashboardData);
		logger.debug('Valid titles identified', {
			uid,
			id,
			validTitles,
			requestedParameters: parameters,
			calculationType,
		});
		if (!parameters.every((p) => validTitles.includes(p))) {
			logger.error('Selected parameters are not valid', {
				uid,
				id,
				parameters,
				validTitles,
				calculationType,
			});
			return res.status(400).json({
				msg: `ERR_INVALID_PARAM: Parameters must be ${calculationType} fields`,
			});
		}

		// Apply dynamic parameter calculation
		dashboardData = calculateDynamicParameters(
			dashboardData,
			parameters,
			operations,
			resultName,
			calculationType
		);

		// Validate updated data structure
		const maxSize = 8 * 1024 * 1024;
		const limitedData = limitDashboardDataSize(dashboardData, maxSize);
		const isValid = limitedData.every(
			(category) =>
				typeof category.cat === 'string' &&
				Array.isArray(category.data) &&
				category.data.every(
					(entry) =>
						typeof entry.i === 'string' &&
						Array.isArray(entry.d) &&
						entry.d.every(
							(node) =>
								typeof node.t === 'string' &&
								node.v !== undefined &&
								node.d instanceof Date
						)
				)
		);
		if (!isValid) {
			logger.error('Invalid dashboard data structure after calculation', {
				uid,
				id,
				sample: JSON.stringify(limitedData.slice(0, 1)),
			});
			return res.status(400).json({
				msg: 'ERR_INVALID_STRUCTURE: Invalid dashboard data structure after calculation',
			});
		}

		// Save updated data to GridFS
		const dashboardJson = JSON.stringify(limitedData);
		if (Buffer.byteLength(dashboardJson, 'utf8') > maxSize) {
			logger.error('Updated data exceeds 8MB', { uid, id });
			return res
				.status(400)
				.json({ msg: 'ERR_SIZE_LIMIT: Updated data exceeds 8MB' });
		}

		const fileId = new mongoose.Types.ObjectId();
		const fileName = `data-${id}-${Date.now()}.json`;
		await writeToGridFS(fileId, fileName, dashboardJson, 'application/json', {
			uid,
		});

		// Update dashboard reference
		if (dashboard.ref?.fid) {
			try {
				await deletionQueue.add(
					{ fileIds: [dashboard.ref.fid] },
					{ attempts: 3 }
				);
			} catch (queueError) {
				logger.warn('Failed to add deletion job to queue', {
					uid,
					id,
					error: queueError.message,
				});
			}
		}
		dashboard.ref = {
			fid: fileId.toString(),
			fn: fileName,
			ch: true,
			cc: 1,
			lu: new Date(),
		};

		await dashboard.save();

		// Cache updated data
		let cacheWarning = null;
		try {
			const cacheKey = `dash:${uid}:${id}:data`;
			const cached = await setCachedDashboard(uid, cacheKey, limitedData);
			if (!cached) {
				cacheWarning = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, id);
		} catch (cacheError) {
			logger.warn('Failed to cache data', {
				uid,
				id,
				error: cacheError.message,
			});
			cacheWarning = 'Cache failed due to error';
		}

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard calculation completed', {
			uid,
			id,
			resultName,
			parameters,
			operations,
			calculationType,
			duration,
		});

		res.status(200).json({
			msg: 'Calculation applied successfully',
			dashboard: {
				_id: dashboard._id,
				name: dashboard.name,
				ref: dashboard.ref,
				f: dashboard.f,
				uid: dashboard.uid,
				ca: dashboard.ca,
				ua: dashboard.ua,
				data: limitedData,
			},
			numericParameters: getNumericTitles(limitedData),
			dateParameters: getDateTitles(limitedData),
			duration,
			cacheWarning,
		});
	} catch (e) {
		logger.error('Error in calculateDashboardParameters', {
			uid,
			id,
			error: e.message,
			stack: e.stack,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId/numeric-titles
 * Retrieves numeric titles for a specific dashboard.
 */
export async function getNumericTitlesEndpoint(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received request for numeric titles', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		authHeader: !!authHeader,
	});

	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		logger.debug('Querying dashboard', { uid, id });
		const dashboard = await Dashboard.findOne({ _id: id, uid }).lean();
		if (!dashboard) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		logger.debug('Fetching dashboard data', { uid, id });
		const dashboardData = await Promise.race([
			Dashboard.prototype.getDashboardData.call(dashboard),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Database query timeout')), 5000)
			),
		]);
		logger.debug('Dashboard data retrieved', {
			uid,
			id,
			categoryCount: dashboardData.length,
		});

		logger.debug('Calculating numeric titles', { uid, id });
		const numericTitles = getNumericTitles(dashboardData);

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved numeric titles', {
			uid,
			id,
			titleCount: numericTitles.length,
			duration,
			titles: numericTitles,
		});

		return res.status(200).json({
			msg: 'Numeric titles retrieved',
			numericTitles,
			duration,
		});
	} catch (e) {
		logger.error('Error in getNumericTitlesEndpoint', {
			uid,
			id,
			error: e.message,
			stack: e.stack,
		});
		return res
			.status(500)
			.json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /users/:userId/dashboard/:dashboardId/date-titles
 * Retrieves date titles for a specific dashboard.
 */
export async function getDateTitlesEndpoint(req, res) {
	const authHeader = req.headers.authorization;
	logger.debug('Received request for date titles', {
		userId: req.params.userId,
		dashboardId: req.params.dashboardId,
		authHeader: !!authHeader,
	});

	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		logger.debug('Querying dashboard', { uid, id });
		const dashboard = await Dashboard.findOne({ _id: id, uid }).lean();
		if (!dashboard) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		logger.debug('Fetching dashboard data', { uid, id });
		const dashboardData = await Promise.race([
			Dashboard.prototype.getDashboardData.call(dashboard),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Database query timeout')), 5000)
			),
		]);
		logger.debug('Dashboard data retrieved', {
			uid,
			id,
			categoryCount: dashboardData.length,
		});

		logger.debug('Calculating date titles', { uid, id });
		const dateTitles = getDateTitles(dashboardData);

		const duration = (Date.now() - start) / 1000;
		logger.info('Retrieved date titles', {
			uid,
			id,
			titleCount: dateTitles.length,
			duration,
		});

		return res.status(200).json({
			msg: 'Date titles retrieved',
			dateTitles,
			duration,
		});
	} catch (e) {
		logger.error('Error in getDateTitlesEndpoint', {
			uid,
			id,
			error: e.message,
			stack: e.stack,
		});
		return res
			.status(500)
			.json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}
