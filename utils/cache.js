import { Redis } from '@upstash/redis';
import winston from 'winston';

// Logger configuration for cache operations
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({
			filename: 'cache-error.log',
			level: 'error',
		}),
		new winston.transports.File({ filename: 'cache-combined.log' }),
	],
});

// Initialize Redis client with Upstash configuration
const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Verify Redis configuration
if (
	!process.env.UPSTASH_REDIS_REST_URL ||
	!process.env.UPSTASH_REDIS_REST_TOKEN
) {
	logger.error(
		'Missing Upstash Redis configuration. Ensure UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN are set in the environment variables.'
	);
	throw new Error(
		'Upstash Redis configuration is incomplete. Please check environment variables.'
	);
}

logger.info('Upstash Redis client initialized successfully.', {
	url: process.env.UPSTASH_REDIS_REST_URL,
});

/**
 * Retrieves a cached dashboard from Upstash Redis.
 * @param {string} userId - The user ID.
 * @param {string} dashboardId - The dashboard ID.
 * @returns {Promise<Object|null>} - The cached dashboard object or null if not found.
 */
export const getCachedDashboard = async (userId, dashboardId) => {
	const cacheKey = `dashboard:${userId}:${dashboardId}`;
	try {
		const cached = await redis.get(cacheKey);
		if (cached) {
			logger.info('Upstash Redis cache hit', { cacheKey });
			return typeof cached === 'string' ? JSON.parse(cached) : cached;
		}
		logger.info('Upstash Redis cache miss', { cacheKey });
		return null;
	} catch (error) {
		logger.error('Error retrieving from Upstash Redis', {
			cacheKey,
			error: error.message,
		});
		return null; // Fallback to database
	}
};

/**
 * Caches a dashboard in Upstash Redis with a 1-hour TTL, if within size limit.
 * @param {string} userId - The user ID.
 * @param {string} dashboardId - The dashboard ID.
 * @param {Object} data - The dashboard or metadata to cache.
 * @returns {Promise<boolean>} - True if cached, false if skipped due to size.
 */
export const setCachedDashboard = async (userId, dashboardId, data) => {
	const dataJson = JSON.stringify(data);
	const sizeInBytes = Buffer.byteLength(dataJson, 'utf8');
	const MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5MB threshold
	const WARN_THRESHOLD = 4 * 1024 * 1024; // 4MB warning threshold

	if (sizeInBytes > WARN_THRESHOLD) {
		logger.warn('Approaching Redis size limit', {
			userId,
			dashboardId,
			sizeInBytes,
			maxSize: MAX_CACHE_SIZE,
		});
	} else if (sizeInBytes < 500 * 1024) {
		logger.info('Caching small object', {
			userId,
			dashboardId,
			sizeInBytes,
		});
	}

	if (sizeInBytes > MAX_CACHE_SIZE) {
		logger.info('Data too large to cache', {
			userId,
			dashboardId,
			sizeInBytes,
			maxSize: MAX_CACHE_SIZE,
		});
		return false; // Skip caching
	}

	const cacheKey = `dashboard:${userId}:${dashboardId}`;
	try {
		await redis.set(cacheKey, dataJson, { ex: 3600 }); // 1-hour TTL
		logger.info('Data cached in Upstash Redis', {
			cacheKey,
			sizeInBytes,
		});
		return true;
	} catch (error) {
		logger.error('Error caching in Upstash Redis', {
			cacheKey,
			sizeInBytes,
			error: error.message,
		});
		throw error; // Rethrow for caller to handle
	}
};

/**
 * Deletes a cached dashboard from Upstash Redis.
 * @param {string} userId - The user ID.
 * @param {string} dashboardId - The dashboard ID.
 * @returns {Promise<void>}
 */
export const deleteCachedDashboard = async (userId, dashboardId) => {
	const cacheKey = `dashboard:${userId}:${dashboardId}`;
	try {
		await redis.del(cacheKey);
		logger.info('Dashboard cache deleted', { cacheKey });
	} catch (error) {
		logger.error('Error deleting from Upstash Redis', {
			cacheKey,
			error: error.message,
		});
		throw error;
	}
};
