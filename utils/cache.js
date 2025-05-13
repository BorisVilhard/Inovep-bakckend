import { Redis } from '@upstash/redis';

// Initialize Redis client with Upstash configuration
const redis = new Redis({
	url: 'https://crack-vervet-30777.upstash.io',
	token: process.env.UPSTASH_REDIS_TOKEN || '********',
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
			console.log('Upstash Redis cache hit:', { cacheKey });
			return typeof cached === 'string' ? JSON.parse(cached) : cached;
		}
		console.log('Upstash Redis cache miss:', { cacheKey });
		return null;
	} catch (error) {
		console.error('Error retrieving from Upstash Redis:', {
			cacheKey,
			error: error.message,
		});
		return null; // Return null on error to fallback to database
	}
};

/**
 * Caches a dashboard in Upstash Redis with a 1-hour TTL.
 * @param {string} userId - The user ID.
 * @param {string} dashboardId - The dashboard ID.
 * @param {Object} dashboard - The dashboard data to cache.
 * @returns {Promise<void>}
 */
export const setCachedDashboard = async (userId, dashboardId, dashboard) => {
	const cacheKey = `dashboard:${userId}:${dashboardId}`;
	try {
		await redis.set(cacheKey, JSON.stringify(dashboard), { ex: 3600 }); // 1-hour TTL
		console.log('Dashboard cached in Upstash Redis:', { cacheKey });
	} catch (error) {
		console.error('Error caching in Upstash Redis:', {
			cacheKey,
			error: error.message,
		});
		throw error; // Rethrow to allow caller to handle
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
		console.log('Dashboard cache deleted:', { cacheKey });
	} catch (error) {
		console.error('Error deleting from Upstash Redis:', {
			cacheKey,
			error: error.message,
		});
		throw error; // Rethrow to allow caller to handle
	}
};
