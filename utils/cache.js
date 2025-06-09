import { Redis } from '@upstash/redis';
import zlib from 'zlib';
import winston from 'winston';

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

const redis = Redis.fromEnv();
const MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5MB threshold

/**
 * Sets compressed dashboard data in Redis.
 * @param {string} uid - User ID.
 * @param {string} k - Cache key.
 * @param {Array} d - Dashboard data.
 * @returns {Promise<boolean>} True if cached, false if too large.
 */
export async function setCachedDashboard(uid, k, d) {
	try {
		const json = JSON.stringify(d);
		const size = Buffer.byteLength(json, 'utf8');
		if (size > MAX_CACHE_SIZE) {
			logger.info('Data too large to cache', {
				uid,
				key: k,
				size,
				max: MAX_CACHE_SIZE,
			});
			return false;
		}

		const compressed = zlib.gzipSync(json);
		const compSize = compressed.length;
		logger.info('Compressed data for cache', {
			uid,
			key: k,
			origSize: size,
			compSize,
		});

		const cacheData = {
			compressed: true,
			origSize: size,
			data: compressed.toString('base64'),
		};

		await redis.set(k, JSON.stringify(cacheData));
		return true;
	} catch (e) {
		logger.error('Error caching data', { uid, key: k, error: e.message });
		return false;
	}
}

/**
 * Gets dashboard data from Redis, decompressing if needed.
 * @param {string} uid - User ID.
 * @param {string} k - Cache key.
 * @returns {Promise<Array|null>} Decompressed data or null if not found.
 */
export async function getCachedDashboard(uid, k) {
	try {
		const cd = await redis.get(k);
		if (!cd) {
			logger.info('Cache miss', { uid, key: k });
			return null;
		}

		const cacheObj = JSON.parse(cd);
		if (!cacheObj.compressed) {
			logger.info('Retrieved uncompressed cache', { uid, key: k });
			return cacheObj;
		}

		const compressed = Buffer.from(cacheObj.data, 'base64');
		const decompressed = zlib.gunzipSync(compressed).toString('utf8');
		const d = JSON.parse(decompressed);
		logger.info('Retrieved compressed cache', {
			uid,
			key: k,
			origSize: cacheObj.origSize,
			compSize: compressed.length,
		});
		return d;
	} catch (e) {
		logger.error('Error retrieving cache', { uid, key: k, error: e.message });
		return null;
	}
}

/**
 * Deletes dashboard data from Redis.
 * @param {string} uid - User ID.
 * @param {string} k - Cache key.
 * @returns {Promise<void>}
 */
export async function deleteCachedDashboard(uid, k) {
	try {
		await redis.del(k);
		logger.info('Deleted cache', { uid, key: k });
	} catch (e) {
		logger.error('Error deleting cache', { uid, key: k, error: e.message });
	}
}
