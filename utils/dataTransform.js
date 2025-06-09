import { format, parse } from 'date-fns';
import winston from 'winston';

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

/**
 * Transforms a JSON string (from Excel/CSV) into JS code defining a 'data' array.
 * @param {string} s - JSON string of objects.
 * @returns {string} JS code defining the array.
 * @throws {Error} If input is invalid or not an array.
 */
export const transformExcelDataToJSCode = (s) => {
	if (typeof s !== 'string' || !s.trim()) {
		logger.error('Invalid input: must be non-empty string', {
			snip: s?.substring(0, 100) || 'undefined',
		});
		throw new Error('ERR_INVALID_INPUT: Input must be a non-empty string');
	}

	try {
		const d = JSON.parse(s);
		if (!Array.isArray(d)) {
			logger.error('Parsed data not an array', {
				snip: s.substring(0, 100),
			});
			throw new Error('ERR_INVALID_DATA: Parsed data must be an array');
		}

		const code = `const data = ${JSON.stringify(d, null, 2)};`; // Reduced indentation
		logger.info('Transformed to JS code', { count: d.length });
		return code;
	} catch (e) {
		logger.error('Error transforming to JS code', {
			error: e.message,
			snip: s.substring(0, 100),
		});
		throw new Error(`ERR_TRANSFORM_FAILED: ${e.message}`);
	}
};

/**
 * Extracts and parses a JS array from a response string.
 * @param {string} s - Response string with JS code.
 * @returns {Array} Parsed array of objects.
 */
export const extractJavascriptCode = (s) => {
	if (typeof s !== 'string' || !s.trim()) {
		logger.error('Invalid input: must be non-empty string', {
			snip: s?.substring(0, 100) || 'undefined',
		});
		return [];
	}

	try {
		const p = /const\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
		const m = s.match(p);
		if (!m) {
			logger.warn('No JS array found', { snip: s.substring(0, 100) });
			return [];
		}

		let js = m[1]
			.replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control chars
			.replace(/(\w+):/g, '"$1":') // Quote keys
			.replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
			.replace(/([{[,\s])'([^']*)'/g, '$1"$2"'); // Fix quotes

		const d = JSON.parse(js);
		if (!Array.isArray(d)) {
			logger.warn('Parsed data not an array', { snip: s.substring(0, 100) });
			return [];
		}

		logger.info('Extracted JS code', { count: d.length });
		return d;
	} catch (e) {
		logger.error('Error decoding JSON', {
			error: e.message,
			snip: s.substring(0, 100),
		});

		// Fallback: Recover partial objects
		const pd = [];
		const op = /{[^}]*}/g;
		const objs = s.match(op) || [];
		for (const o of objs) {
			try {
				const co = o
					.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
					.replace(/(\w+):/g, '"$1":')
					.replace(/,\s*}/g, '}')
					.replace(/([{[,\s])'([^']*)'/g, '$1"$2"');
				pd.push(JSON.parse(co));
			} catch (er) {
				logger.debug('Failed to parse partial object', {
					obj: o.substring(0, 50),
					error: er.message,
				});
			}
		}

		logger.info('Recovered partial data', { count: pd.length });
		return pd;
	}
};

/**
 * Transforms raw data into DashboardCategorySchema structure.
 * @param {Array} d - Array of data objects from file.
 * @param {string} fn - File name.
 * @returns {Object} Object with dashboardData array.
 */
export function transformDataStructure(d, fn) {
	if (!Array.isArray(d) || typeof fn !== 'string' || !fn.trim()) {
		logger.warn('Invalid input: data must be array, fileName a string', {
			fn: fn || 'undefined',
			type: typeof d,
		});
		return { dashboardData: [] };
	}

	if (d.length === 0) {
		logger.warn('No data provided', { fn });
		return { dashboardData: [] };
	}

	const dd = [];
	const fbDate = format(new Date(), 'yyyy-MM-dd');
	const dateFormats = [
		/^\d{4}-\d{2}-\d{2}$/, // YYYY-MM-DD
		/^\d{2}\/\d{2}\/\d{4}$/, // MM/DD/YYYY
		/^\d{4}-\d{2}$/, // YYYY-MM
	];
	const BS = parseInt(process.env.BATCH_SIZE, 10) || 1000;

	const isStr = (v) => {
		if (typeof v !== 'string' || !v.trim()) return false;
		if (!isNaN(parseFloat(v)) && isFinite(v)) return false;
		if (dateFormats.some((rx) => rx.test(v.trim()))) return false;
		return true;
	};

	const prefCols = ['Notes', 'Description', 'Comments'];
	let sck = null;
	const ks = Object.keys(d[0] || {});
	logger.info('Available cols', { fn, cols: ks });

	if (ks.length > 0) {
		for (const k of prefCols) {
			if (ks.includes(k) && d.every((i) => i[k] && isStr(i[k]))) {
				sck = k;
				break;
			}
		}
		if (!sck) {
			for (const k of ks) {
				if (d.every((i) => i[k] && isStr(i[k]))) {
					sck = k;
					break;
				}
			}
		}
	}
	logger.info('Selected string col', { fn, sck });

	for (let i = 0; i < d.length; i += BS) {
		const b = d.slice(i, i + BS);
		b.forEach((it, idx) => {
			if (!it || typeof it !== 'object') {
				logger.warn('Skipping invalid item', { fn, idx: i + idx });
				return;
			}

			const iks = Object.keys(it);
			if (iks.length === 0) {
				logger.warn('Skipping empty item', { fn, idx: i + idx });
				return;
			}

			let dt = null;
			for (const k of iks) {
				const v = it[k];
				if (typeof v === 'string' && v.trim()) {
					const t = v.trim();
					if (dateFormats[0].test(t)) {
						dt = t; // YYYY-MM-DD
						break;
					} else if (dateFormats[1].test(t)) {
						try {
							dt = format(parse(t, 'MM/dd/yyyy', new Date()), 'yyyy-MM-dd');
							break;
						} catch {}
					} else if (dateFormats[2].test(t)) {
						dt = `${t}-01`; // YYYY-MM
						break;
					}
				}
			}

			let cat =
				sck && it[sck] && isStr(it[sck])
					? String(it[sck]).trim()
					: iks.length > 0
					? String(it[iks[0]] || 'Unknown').trim()
					: 'Unknown';

			const cs = [];
			for (const k of iks) {
				if (k === sck) continue;
				const ct = String(k).trim() || 'unk_col';
				const v = it[k];
				let cv =
					typeof v === 'string' && !dateFormats.some((rx) => rx.test(v.trim()))
						? cleanNumeric(v)
						: v;

				if (cv === undefined || cv === null) {
					logger.debug('Skipping invalid value', { fn, k, idx: i + idx });
					continue;
				}

				const cid = generateChartId(cat, ct);
				cs.push({
					i: cid,
					d: [{ t: ct, v: cv, d: new Date(dt || fbDate) }],
				});
			}

			if (cs.length === 0) {
				logger.warn('No charts generated', { fn, idx: i + idx });
				return;
			}

			dd.push({
				cat,
				data: cs,
				comb: [],
				sum: [],
				chart: 'Area',
				ids: [],
			});
		});
	}

	logger.info('Transformed data', {
		fn,
		count: dd.length,
		sample: dd.slice(0, 2), // Reduced sample size
	});

	return { dashboardData: dd };
}

/**
 * Cleans string values to numeric format if possible.
 * @param {any} v - Value to clean.
 * @returns {number|string|any} Cleaned value.
 */
export function cleanNumeric(v) {
	if (typeof v !== 'string' || !v.trim()) return v;

	const m = v.match(/-?\d+(\.\d+)?/);
	if (m) {
		const s = m[0];
		return s.includes('.') ? parseFloat(s) : parseInt(s, 10);
	}

	return v;
}

/**
 * Generates a unique chart ID from category and title.
 * @param {string} c - Category name.
 * @param {string} t - Chart title.
 * @returns {string} Chart ID.
 */
export function generateChartId(c, t) {
	const sc = typeof c === 'string' ? c.trim() : String(c || 'unk');
	const st = typeof t === 'string' ? t.trim() : String(t || 'unk');

	const id = `${sc.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${st
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')}`.replace(/^-|-$/g, '');

	logger.debug('Generated ID', { cat: sc, title: st, id });
	return id;
}
