import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import xlsx from 'xlsx';
import winston from 'winston';
import Queue from 'bull';
import { Redis } from '@upstash/redis';
import Papa from 'papaparse';
import zlib from 'zlib';
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
	logger.info('GridFS initialized');
});

// Initialize Redis and Bull Queue
const redis = Redis.fromEnv();
const deletionQueue = new Queue('gridfs-deletion', {
	redis: {
		url:
			process.env.UPSTASH_REDIS_REST_URL ||
			'https://crack-vervet-30777.upstash.io',
		password:
			process.env.UPSTASH_REDIS_REST_TOKEN || 'YOUR_UPSTASH_REDIS_TOKEN',
	},
});

// Valid chart types for category chart
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

/**
 * Validates authentication token (stub; replace with actual middleware)
 * @param {string} authHeader - Authorization header
 * @returns {boolean} True if valid, false otherwise
 */
function validateAuth(authHeader) {
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		logger.warn('Missing or invalid Authorization header', { authHeader });
		return false;
	}
	// Replace with actual token validation (e.g., JWT verify)
	const token = authHeader.split(' ')[1];
	return !!token; // Stub: assumes non-empty token is valid
}

/**
 * Sanitizes JSON string by removing non-printable characters.
 * @param {string} s - JSON string.
 * @returns {string} Sanitized string.
 */
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

/**
 * Sanitizes a key for JSON.
 * @param {string} k - Key to sanitize.
 * @returns {string} Sanitized key.
 */
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

/**
 * Validates XLSX file structure.
 * @param {Buffer} b - File buffer.
 * @param {string} fn - File name.
 * @param {string} uid - User ID.
 * @returns {Object} { valid: boolean, error?: string }
 */
function validateXlsxStructure(b, fn, uid) {
	try {
		// Check magic bytes for .xlsx (ZIP format)
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

		// Find first sheet case-insensitively
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

		// Parse to JSON to check data integrity
		const data = xlsx.utils.sheet_to_json(sheet, {
			raw: false,
			defval: null,
			header: 1,
		});
		logger.info('Extracted XLSX data', {
			uid,
			fn,
			rows: data.length,
			sheetName: sn,
		});

		// Log warnings for control characters but don't fail
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
						.map((v) => ({ v: v.substring(0, 50), i }));
					if (invalid.length) {
						logger.warn('Control chars in row', {
							uid,
							fn,
							row: i,
							invalid,
						});
					}
				}
			});
		} else {
			logger.warn('No data rows', { uid, fn });
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

/**
 * Sanitizes Excel data.
 * @param {Array} d - Data array from sheet_to_json.
 * @returns {Array} Sanitized data array.
 */
function sanitizeExcelData(d) {
	return d.map((row) => {
		const sanitized = {};
		Object.entries(row).forEach(([k, v]) => {
			const sk = sanitizeKey(k);
			sanitized[sk] =
				v !== null && typeof v === 'string'
					? v.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
					: v;
		});
		return sanitized;
	});
}

/**
 * Parses Excel buffer into JSON data.
 * @param {Buffer} b - Excel file buffer.
 * @param {Function} cb - Callback for batch processing.
 * @returns {Promise<Array>} Parsed data.
 */
async function parseExcelStream(b, cb) {
	const wb = xlsx.read(b, {
		type: 'buffer',
		cellDates: true,
		raw: false,
		cellText: false,
	});
	const sn =
		wb.SheetNames.find((n) => n.toLowerCase().includes('sheet')) ||
		wb.SheetNames[0];
	const sheet = wb.Sheets[sn];
	const data = [];
	const batchSize = 1000;

	const jsonData = xlsx.utils.sheet_to_json(sheet, {
		raw: false,
		defval: null,
	});
	for (let i = 0; i < jsonData.length; i += batchSize) {
		const batch = jsonData.slice(i, i + batchSize);
		data.push(...batch);
		cb(batch);
		await new Promise((r) => setTimeout(r, 0));
		logger.info(`Processed ${data.length} rows`, { fileName: sn });
	}
	return data;
}

/**
 * Parses CSV buffer into JSON data.
 * @param {Buffer} b - CSV file buffer.
 * @returns {Promise<Array>} Parsed data.
 */
function parseCsv(b) {
	return new Promise((resolve, reject) => {
		Papa.parse(b.toString(), {
			header: true,
			chunkSize: 1000,
			step: (r) => logger.info(`Processed CSV chunk`, { rows: r.data.length }),
			complete: (r) => resolve(r.data),
			error: (e) => reject(e),
		});
	});
}

/**
 * Limits dashboard data size to 8MB.
 * @param {Array} d - Dashboard data array.
 * @param {number} max - Maximum size in bytes.
 * @returns {Array} Truncated data.
 */
function limitDashboardDataSize(d, max = 8 * 1024 * 1024) {
	let size = 0;
	const limited = [];

	for (const cat of d) {
		const catSize = Buffer.byteLength(JSON.stringify(cat), 'utf8');
		if (size + catSize <= max) {
			limited.push(cat);
			size += catSize;
		} else {
			break;
		}
	}

	logger.info('Limited dashboard data size', {
		origSize: Buffer.byteLength(JSON.stringify(d), 'utf8'),
		newSize: size,
		kept: limited.length,
	});
	return limited;
}

/**
 * Writes data to GridFS, compressing JSON.
 * @param {string|ObjectId} fid - File ID.
 * @param {string} fn - Filename.
 * @param {string|Buffer} d - Data to write.
 * @param {string} ct - Content type.
 * @param {Object} m - Metadata.
 * @returns {Promise<string>} File ID.
 */
async function writeToGridFS(fid, fn, d, ct, m) {
	const buf = typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
	const compressed = ct === 'application/json' ? zlib.gzipSync(buf) : buf;
	const ws = gfs.openUploadStreamWithId(mongoose.Types.ObjectId(fid), fn, {
		contentType: ct,
		metadata: { ...m, compressed: ct === 'application/json' },
	});
	ws.write(compressed);
	ws.end();
	await new Promise((r, j) => {
		ws.on('finish', r);
		ws.on('error', j);
	});
	return fid.toString();
}

/**
 * POST /users/:userId/dashboard/upload
 */
export async function createOrUpdateDashboard(req, res) {
	const authHeader = req.headers.authorization;
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const uid = req.params.userId;
	const start = Date.now();
	let ck;

	try {
		if (!mongoose.Types.ObjectId.isValid(uid)) {
			logger.error('Invalid userId', { uid });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid userId' });
		}

		const { id, name, chunkIdx, totalChunks } = req.body;
		const file = req.file;
		if (!file) {
			logger.error('No file uploaded', { uid });
			return res.status(400).json({ msg: 'No file uploaded' });
		}

		const ft = file.mimetype;
		const fn = file.originalname;
		logger.info('Processing file', { uid, fn, ft, size: file.buffer.length });

		const allowedMime = [
			'text/csv',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'application/octet-stream',
		];
		const allowedExt = ['.csv', '.xlsx', '.xls'];
		const ext = fn.toLowerCase().match(/\.[^\.]+$/)?.[0] || '';

		if (!allowedMime.includes(ft) || !allowedExt.includes(ext)) {
			logger.error('Invalid file type', { uid, fn, ft, ext });
			return res
				.status(400)
				.json({ msg: 'Only CSV and Excel files supported' });
		}

		let fb;
		const MAX_CHUNK = 500 * 1024; // 500 KB
		const MAX_FILE = 6 * 1024 * 1024; // 6MB
		ck = `chunk:${uid}:${id || 'new'}:${fn}`;

		if (totalChunks && chunkIdx !== undefined) {
			const ci = parseInt(chunkIdx, 10);
			const tc = parseInt(totalChunks, 10);

			if (isNaN(ci) || isNaN(tc) || ci >= tc || ci < 0) {
				logger.error('Invalid chunk params', { uid, chunkIdx, totalChunks });
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_CHUNK: Invalid chunk parameters' });
			}

			if (file.buffer.length > MAX_CHUNK) {
				logger.error('Chunk size exceeds max', { uid, fn, chunkIdx: ci });
				return res.status(400).json({ msg: 'Chunk size exceeds 500KB' });
			}

			await redis.rpush(ck, file.buffer.toString('base64')); // Store as base64
			logger.info('Stored chunk', {
				uid,
				fn,
				chunkIdx: ci,
				totalChunks: tc,
				size: file.buffer.length,
			});

			if (ci < tc - 1) {
				const prog = ((ci + 1) / tc) * 100;
				return res.status(200).json({
					msg: `Chunk ${ci + 1} of ${tc} uploaded`,
					chunkIdx: ci,
					totalChunks: tc,
					prog: prog.toFixed(2),
				});
			}

			const chunks = await redis.lrange(ck, 0, -1);
			fb = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
			await redis.del(ck);

			if (fb.length > MAX_FILE) {
				logger.error('File size exceeds max', { uid, fn, size: fb.length });
				return res.status(400).json({ msg: 'File size exceeds 6MB' });
			}

			logger.debug('Reassembled buffer', {
				uid,
				fn,
				size: fb.length,
				sample: fb.slice(0, 100).toString('hex'),
			});
		} else {
			fb = file.buffer;
		}

		let rd = [];
		const onBatch = (b) => {
			rd.push(...b);
			logger.info(`Processed ${b.length} rows`, { uid, fn });
		};

		if (fn.endsWith('.csv')) {
			rd = await parseCsv(fb);
		} else if (fn.endsWith('.xlsx') || fn.endsWith('.xls')) {
			const validation = validateXlsxStructure(fb, fn, uid);
			if (!validation.valid) {
				logger.error('XLSX validation failed', {
					uid,
					fn,
					details: validation.error,
				});
				return res.status(400).json({
					msg: 'Invalid XLSX structure',
					details:
						validation.error ||
						'Failed to parse Excel file; ensure valid format and data',
				});
			}
			rd = await parseExcelStream(fb, onBatch);
			rd = sanitizeExcelData(rd);
		} else {
			return res.status(400).json({ msg: 'Unsupported file type' });
		}

		if (!Array.isArray(rd) || rd.length === 0) {
			logger.error('No valid data extracted', { uid, fn });
			return res
				.status(400)
				.json({ msg: 'ERR_NO_DATA: No valid data extracted from file' });
		}

		let dt;
		try {
			dt = JSON.stringify(rd);
			JSON.parse(dt);
		} catch (e) {
			try {
				dt = sanitizeJsonString(JSON.stringify(rd));
				JSON.parse(dt);
			} catch (err) {
				logger.error('Failed to sanitize JSON', {
					uid,
					fn,
					error: err.message,
				});
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_DATA: Invalid or corrupted data' });
			}
		}

		const resp = transformExcelDataToJSCode(dt);
		const extData = extractJavascriptCode(resp);
		const { dashboardData } = transformDataStructure(extData, fn);

		if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
			logger.error('No valid dashboard data', { uid, fn });
			return res
				.status(400)
				.json({ msg: 'ERR_NO_DATA: No valid dashboard data extracted' });
		}

		const maxSz = 8 * 1024 * 1024;
		const limData = limitDashboardDataSize(dashboardData, maxSz);

		const isValid = limData.every(
			(c) =>
				typeof c.cat === 'string' &&
				Array.isArray(c.data) &&
				c.data.every(
					(e) =>
						typeof e.i === 'string' &&
						Array.isArray(e.d) &&
						e.d.every(
							(n) =>
								typeof n.t === 'string' &&
								n.v !== undefined &&
								n.d instanceof Date
						)
				)
		);
		if (!isValid) {
			logger.error('Invalid dashboard data structure', { uid, fn });
			return res.status(400).json({
				msg: 'ERR_INVALID_STRUCTURE: Invalid dashboard data structure',
			});
		}

		const ddJson = JSON.stringify(limData);
		const dfid = new mongoose.Types.ObjectId();
		const dfn = `data-${id || 'new'}-${Date.now()}.json`;
		await writeToGridFS(dfid, dfn, ddJson, 'application/json', { uid });

		let fid;
		let ch = false;
		const GRIDFS_THRESH = 300 * 1024;
		if (fb.length > GRIDFS_THRESH) {
			fid = new mongoose.Types.ObjectId();
			await writeToGridFS(fid, fn, fb, ft, { uid });
			ch = true;
		}

		const fd = {
			fid: fid || new mongoose.Types.ObjectId().toString(),
			fn,
			c: ch ? undefined : fb,
			src: 'local',
			ch,
			cc: totalChunks ? parseInt(totalChunks, 10) : 1,
			lu: new Date(),
			mon: { s: 'active' },
		};

		const dref = {
			fid: dfid.toString(),
			fn: dfn,
			ch: true,
			cc: 1,
			lu: new Date(),
		};

		let d;
		if (id) {
			if (!mongoose.Types.ObjectId.isValid(id)) {
				logger.error('Invalid dashboard ID', { uid, id });
				return res
					.status(400)
					.json({ msg: 'ERR_INVALID_ID: Invalid dashboard ID' });
			}

			d = await Dashboard.findOne({ _id: id, uid });
			if (!d) {
				logger.error('Dashboard not found', { uid, id });
				return res
					.status(404)
					.json({ msg: `ERR_NOT_FOUND: Dashboard ID ${id} not found` });
			}

			const existingData = await d.getDashboardData();
			const mergedData = mergeDashboardData(existingData, limData);
			const finalData = limitDashboardDataSize(mergedData, maxSz);

			const finalJson = JSON.stringify(finalData);
			if (Buffer.byteLength(finalJson, 'utf8') > maxSz) {
				logger.error('Merged data exceeds 8MB', { uid, id });
				return res
					.status(400)
					.json({ msg: 'ERR_SIZE_LIMIT: Merged data exceeds 8MB' });
			}

			const nfid = new mongoose.Types.ObjectId();
			const nfn = `data-${id}-${Date.now()}.json`;
			await writeToGridFS(nfid, nfn, finalJson, 'application/json', { uid });

			if (d.ref?.fid) {
				await deletionQueue.add({ fileIds: [d.ref.fid] }, { attempts: 3 });
			}

			d.ref = {
				fid: nfid.toString(),
				fn: nfn,
				ch: true,
				cc: 1,
				lu: new Date(),
			};
			d.f.push(fd);
		} else if (name) {
			const exists = await Dashboard.findOne({ name, uid }).lean();
			if (exists) {
				logger.error('Dashboard name exists', { uid, name });
				return res
					.status(400)
					.json({ msg: 'ERR_NAME_EXISTS: Dashboard name exists' });
			}
			d = new Dashboard({
				name,
				ref: dref,
				f: [fd],
				uid,
			});
		} else {
			logger.error('ID or name required', { uid });
			return res
				.status(400)
				.json({ msg: 'ERR_MISSING_PARAM: ID or name required' });
		}

		await d.save();
		const cacheData = id ? finalData : limData;
		let cw = null;

		try {
			const ck = `dash:${uid}:${d._id}:data`;
			const cached = await setCachedDashboard(uid, ck, cacheData);
			if (!cached) {
				cw = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, d._id);
		} catch (e) {
			logger.warn('Failed to cache data', { uid, id: d._id, error: e.message });
			cw = 'Cache failed due to server issue';
		}

		const dur = (Date.now() - start) / 1000;
		logger.info('Dashboard processed', { uid, id: d._id, fn, dur });

		res.status(201).json({
			msg: 'Dashboard processed',
			d: {
				_id: d._id,
				name: d.name,
				ref: d.ref,
				f: d.f,
				uid: d.uid,
				ca: d.ca,
				ua: d.ua,
				data: cacheData,
			},
			dur,
			cw,
		});
	} catch (e) {
		logger.error('Error in createOrUpdateDashboard', {
			uid,
			fn: req.file?.originalname,
			error: e.message,
		});
		if (ck) {
			await redis
				.del(ck)
				.catch((err) =>
					logger.error('Failed to clean Redis', { error: err.message })
				);
		}
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * PUT /users/:userId/dashboard/:dashboardId/category/:categoryName
 */
export async function updateCategoryData(req, res) {
	const authHeader = req.headers.authorization;
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id, categoryName: cn } = req.params;
	const dcn = decodeURIComponent(cn);
	const start = Date.now();

	try {
		if (
			!mongoose.Types.ObjectId.isValid(uid) ||
			!mongoose.Types.ObjectId.isValid(id)
		) {
			logger.error('Invalid uid or id', { uid, id });
			return res.status(400).json({ msg: 'ERR_INVALID_ID: Invalid uid or id' });
		}

		const d = await Dashboard.findOne({ _id: id, uid });
		if (!d) {
			logger.error('Dashboard not found', { id, uid });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const cat = (await d.getDashboardData()).find((c) => c.cat === dcn);
		if (!cat) {
			logger.error('Category not found', { cat: dcn, id, uid });
			return res.status(404).json({ msg: 'ERR_NOT_FOUND: Category not found' });
		}

		const { chart, ids } = req.body;
		if (chart && !validChartTypes.includes(chart)) {
			logger.error('Invalid chart type', { chart, uid, id });
			return res
				.status(400)
				.json({ msg: 'ERR_INVALID_CHART: Invalid chart type' });
		}

		if (chart) cat.chart = chart;
		if (Array.isArray(ids)) cat.ids = ids;

		const dd = await d.getDashboardData();
		const ddJson = JSON.stringify(dd);
		const maxSz = 8 * 1024 * 1024;
		if (Buffer.byteLength(ddJson, 'utf8') > maxSz) {
			logger.error('Data exceeds 8MB', { uid, id });
			return res.status(400).json({ msg: 'ERR_SIZE_LIMIT: Data exceeds 8MB' });
		}

		const dfid = new mongoose.Types.ObjectId();
		const dfn = `data-${id}-${Date.now()}.json`;
		await writeToGridFS(dfid, dfn, ddJson, { uid });

		d.ref = {
			fid: dfid.toString(),
			fn: dfn,
			ch: true,
			cc: 1,
			lu: new Date(),
		};
		await d.save();

		let cw = null;
		try {
			const ck = `dash:${uid}:${d._id}:data`;
			const cached = await setCachedDashboard(uid, ck, dd);
			if (!cached) {
				cw = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, d._id);
		} catch (e) {
			logger.warn('Failed to cache data', { uid, id, error: e.message });
			cw = 'Cache failed';
		}

		const dur = (Date.now() - start) / 1000;
		logger.info('Updated category', { uid, id, cat: dcn, dur });
		res.status(200).json({ msg: 'Category updated', dur, cw });
	} catch (e) {
		logger.error('Error updating category', {
			uid,
			id,
			cat: dcn,
			error: e.message,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * DELETE /auth/users/:userId/dashboard/:dashboardId
 */
export async function deleteDashboardData(req, res) {
	const authHeader = req.headers.authorization;
	if (!validateAuth(authHeader)) {
		logger.error('Unauthorized access attempt', { userId: req.params.userId });
		return res.status(401).json({ msg: 'Unauthorized' });
	}

	const { userId: uid, dashboardId: id } = req.params;
	const start = Date.now();

	try {
		const { modifiedCount, queuedFiles, duration } =
			await Dashboard.deleteDashboardData(id, uid);
		res.status(200).json({
			msg: 'Dashboard deleted',
			modifiedCount,
			queuedFiles,
			dur: duration,
		});
	} catch (e) {
		logger.error('Error in deleteDashboardData', { uid, id, error: e.message });
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /auth/users/:userId/dashboard/:dashboardId
 */
export async function getDashboardData(req, res) {
	const authHeader = req.headers.authorization;
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

		const ck = `dash:${uid}:${id}:data`;
		const cd = await getCachedDashboard(uid, ck);
		if (cd) {
			const d = await Dashboard.findOne(
				{ _id: id, uid },
				{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
			);
			if (!d) {
				logger.warn('Dashboard not found', { uid, id });
				return res
					.status(404)
					.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
			}
			const dur = (Date.now() - start) / 1000;
			logger.info('Retrieved from cache', { uid, id, dur });
			return res.status(200).json({
				msg: 'Dashboard retrieved',
				d: { ...d.toObject(), data: cd },
				dur,
			});
		}

		const d = await Dashboard.findOne(
			{ _id: id, uid },
			{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
		);
		if (!d) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const dd = await d.getDashboardData();
		const dobj = { ...d.toObject(), data: dd };

		let cw = null;
		try {
			const cached = await setCachedDashboard(uid, ck, dd);
			if (!cached) {
				cw = 'Data too large to cache';
			}
			await Dashboard.cacheDashboardMetadata(uid, d._id);
		} catch (e) {
			logger.warn('Failed to cache data', { uid, id, error: e.message });
			cw = 'Cache failed';
		}

		const dur = (Date.now() - start) / 1000;
		logger.info('Retrieved from DB', { uid, id, cats: dd.length, dur });

		res.status(200).json({
			msg: 'Dashboard retrieved',
			d: dobj,
			dur,
			cw,
		});
	} catch (e) {
		logger.error('Error in getDashboardData', { uid, id, error: e.message });
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /auth/users/:userId/dashboards
 */
export async function getAllDashboards(req, res) {
	const authHeader = req.headers.authorization;
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
			const dur = (Date.now() - start) / 1000;
			logger.info('Retrieved all dashboards from cache', {
				uid,
				count: cachedData.length,
				dur,
			});
			return res.status(200).json({
				msg: 'Dashboards retrieved',
				ds: cachedData,
				dur,
			});
		}

		const ds = await Dashboard.find(
			{ uid },
			{ name: 1, ref: 1, f: 1, uid: 1, ca: 1, ua: 1 }
		).lean();

		let cw = null;
		try {
			const cached = await setCachedDashboard(uid, cacheKey, ds);
			if (!cached) {
				cw = 'Data too large to cache';
			}
		} catch (e) {
			logger.warn('Failed to cache dashboards', { uid, error: e.message });
			cw = 'Cache failed';
		}

		const dur = (Date.now() - start) / 1000;
		logger.info('Retrieved all dashboards from DB', {
			uid,
			count: ds.length,
			dur,
		});

		res.status(200).json({
			msg: 'Dashboards retrieved',
			ds,
			dur,
			cw,
		});
	} catch (e) {
		logger.error('Error in getAllDashboards', { uid, error: e.message });
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}

/**
 * GET /auth/users/:userId/dashboard/:dashboardId/file/:fileId
 */
export async function downloadDashboardFile(req, res) {
	const authHeader = req.headers.authorization;
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

		const d = await Dashboard.findOne({ _id: id, uid });
		if (!d) {
			logger.warn('Dashboard not found', { uid, id });
			return res
				.status(404)
				.json({ msg: 'ERR_NOT_FOUND: Dashboard not found' });
		}

		const fd = d.f.find((f) => f.fid === fid);
		if (!fd) {
			logger.warn('File not found', { uid, id, fid });
			return res.status(404).json({ msg: 'ERR_NOT_FOUND: File not found' });
		}

		if (!fd.ch) {
			res.set({
				'Content-Type': fd.contentType || 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${fd.fn}"`,
			});
			res.send(fd.c);
			const dur = (Date.now() - start) / 1000;
			logger.info('Served non-chunked file', { uid, id, fid, dur });
			return;
		}

		const ds = gfs.openDownloadStream(new mongoose.Types.ObjectId(fid));
		res.set({
			'Content-Type': fd.contentType || 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${fd.fn}"`,
		});
		ds.pipe(res);

		ds.on('error', (e) => {
			logger.error('Error streaming file', { uid, id, fid, error: e.message });
			if (!res.headersSent) {
				res.status(500).json({ msg: 'ERR_SERVER: Error streaming file' });
			}
		});

		ds.on('end', () => {
			const dur = (Date.now() - start) / 1000;
			logger.info('File download completed', { uid, id, fid, dur });
		});
	} catch (e) {
		logger.error('Error in downloadDashboardFile', {
			uid,
			id,
			fid,
			error: e.message,
		});
		res.status(500).json({ msg: 'ERR_SERVER: Server error', error: e.message });
	}
}
