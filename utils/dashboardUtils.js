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
 * Merges new dashboard data into existing data efficiently.
 * @param {Array} ex - Existing dashboard data.
 * @param {Array} nw - New dashboard data to merge.
 * @returns {Array} Merged dashboard data.
 */
export const mergeDashboardData = (ex, nw) => {
	// Validate inputs
	if (!Array.isArray(ex) || !Array.isArray(nw)) {
		logger.warn('Invalid input: ex and nw must be arrays', {
			exType: typeof ex,
			nwType: typeof nw,
		});
		return ex && Array.isArray(ex) ? [...ex] : [];
	}

	// Create a map for existing categories
	const catMap = new Map();
	ex.forEach((c, idx) => {
		const cn = c.cat || c.categoryName; // Handle legacy data
		if (typeof cn !== 'string' || !cn.trim()) {
			logger.warn('Skipping invalid category', { index: idx, cat: cn });
			return;
		}
		catMap.set(cn, { ...c, cat: cn });
	});

	nw.forEach((nc, idx) => {
		const cn = nc.cat || nc.categoryName; // Handle legacy data
		if (typeof cn !== 'string' || !cn.trim()) {
			logger.warn('Skipping invalid new category', { index: idx, cat: cn });
			return;
		}

		// Check if category exists
		if (catMap.has(cn)) {
			const ec = catMap.get(cn);

			// Validate and merge data
			if (Array.isArray(nc.data)) {
				const chartMap = new Map();
				if (Array.isArray(ec.data)) {
					ec.data.forEach((e) => {
						if (typeof e.i === 'string') chartMap.set(e.i, e);
					});
				}

				nc.data.forEach((ne) => {
					if (typeof ne.i !== 'string' || !Array.isArray(ne.d)) {
						logger.debug('Skipping invalid chart', { cat: cn, chartId: ne.i });
						return;
					}
					if (chartMap.has(ne.i)) {
						const ee = chartMap.get(ne.i);
						const nv = ne.d[0]?.v;

						if (typeof nv === 'string') {
							ee.d = ne.d; // Replace for string values
						} else {
							ee.d = [...ee.d, ...ne.d]; // Append for others
						}
					} else {
						// Add new chart
						ec.data = ec.data || [];
						ec.data.push(ne);
						chartMap.set(ne.i, ne);
					}
				});
			}

			// Merge comb if exists
			if (Array.isArray(nc.comb) && nc.comb.length > 0) {
				const combMap = new Map();
				if (Array.isArray(ec.comb)) {
					ec.comb.forEach((c) => {
						if (typeof c.i === 'string') combMap.set(c.i, c);
					});
				}

				nc.comb.forEach((ncc) => {
					if (typeof ncc.i !== 'string' || !Array.isArray(ncc.d)) {
						logger.debug('Skipping invalid combined chart', {
							cat: cn,
							chartId: ncc.i,
						});
						return;
					}
					if (combMap.has(ncc.i)) {
						const ecc = combMap.get(ncc.i);
						ecc.c = ncc.c || ecc.c;
						ecc.d = ncc.d;
					} else {
						ec.comb = ec.comb || [];
						ec.comb.push(ncc);
						combMap.set(ncc.i, ncc);
					}
				});
			}

			// Merge sum if exists
			if (Array.isArray(nc.sum) && nc.sum.length > 0) {
				ec.sum = ec.sum || [];
				ec.sum.push(...nc.sum);
			}

			// Update chart and ids if provided
			if (nc.chart && typeof nc.chart === 'string') ec.chart = nc.chart;
			if (Array.isArray(nc.ids)) {
				ec.ids = ec.ids || [];
				ec.ids = [...new Set([...ec.ids, ...nc.ids])];
			}
		} else {
			// Add new category
			if (Array.isArray(nc.data) && typeof cn === 'string') {
				catMap.set(cn, {
					cat: cn,
					data: nc.data,
					comb: nc.comb || [],
					sum: nc.sum || [],
					chart: nc.chart || 'Area',
					ids: nc.ids || [],
				});
			} else {
				logger.warn('Skipping invalid new category', { index: idx, cat: cn });
			}
		}
	});

	const merged = Array.from(catMap.values());
	logger.info('Merged dashboard data', {
		exCount: ex.length,
		nwCount: nw.length,
		mergedCount: merged.length,
	});

	return merged;
};
