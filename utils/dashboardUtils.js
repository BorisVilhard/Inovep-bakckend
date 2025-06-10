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
 * @param {Array} existingData - Existing dashboard data array.
 * @param {Array} newData - New dashboard data array to merge.
 * @returns {Array} Merged dashboard data array.
 */
export const mergeDashboardData = (existingData, newData) => {
	if (!Array.isArray(existingData) || !Array.isArray(newData)) {
		logger.warn('Invalid input: existingData and newData must be arrays', {
			existingType: typeof existingData,
			newType: typeof newData,
		});
		return existingData && Array.isArray(existingData) ? [...existingData] : [];
	}

	const startTime = Date.now();
	const categoryMap = new Map();
	existingData.forEach((category, index) => {
		const categoryName = category.cat || category.categoryName;
		if (typeof categoryName !== 'string' || !categoryName.trim()) {
			logger.warn('Skipping invalid category', { index, categoryName });
			return;
		}
		categoryMap.set(categoryName, { ...category, cat: categoryName });
	});

	newData.forEach((newCategory, index) => {
		const categoryName = newCategory.cat || newCategory.categoryName;
		if (typeof categoryName !== 'string' || !categoryName.trim()) {
			logger.warn('Skipping invalid new category', { index, categoryName });
			return;
		}

		if (Array.isArray(newCategory.data) && newCategory.data.length === 0) {
			logger.warn('Empty data array in new category', { categoryName });
		}

		if (categoryMap.has(categoryName)) {
			const existingCategory = categoryMap.get(categoryName);

			if (Array.isArray(newCategory.data)) {
				const chartMap = new Map();
				if (Array.isArray(existingCategory.data)) {
					existingCategory.data.forEach((entry) => {
						if (typeof entry.i === 'string') chartMap.set(entry.i, entry);
					});
				}

				newCategory.data.forEach((newEntry) => {
					if (
						typeof newEntry.i !== 'string' ||
						!Array.isArray(newEntry.d) ||
						!newEntry.d.every((node) => node.d instanceof Date)
					) {
						logger.debug('Skipping invalid chart', {
							categoryName,
							chartId: newEntry.i,
						});
						return;
					}
					if (chartMap.has(newEntry.i)) {
						const existingEntry = chartMap.get(newEntry.i);
						const newValue = newEntry.d[0]?.v;
						const existingValue = existingEntry.d[0]?.v;
						if (typeof newValue === typeof existingValue) {
							existingEntry.d = newEntry.d;
						} else {
							existingEntry.d = [...existingEntry.d, ...newEntry.d];
							logger.warn('Type mismatch in chart data', {
								categoryName,
								chartId: newEntry.i,
								existingType: typeof existingValue,
								newType: typeof newValue,
							});
						}
					} else {
						existingCategory.data = existingCategory.data || [];
						existingCategory.data.push(newEntry);
						chartMap.set(newEntry.i, newEntry);
					}
				});
			}

			if (Array.isArray(newCategory.comb) && newCategory.comb.length > 0) {
				const combinedChartMap = new Map();
				if (Array.isArray(existingCategory.comb)) {
					existingCategory.comb.forEach((chart) => {
						if (typeof chart.i === 'string')
							combinedChartMap.set(chart.i, chart);
					});
				}

				newCategory.comb.forEach((newCombinedChart) => {
					if (
						typeof newCombinedChart.i !== 'string' ||
						!Array.isArray(newCombinedChart.d)
					) {
						logger.debug('Skipping invalid combined chart', {
							categoryName,
							chartId: newCombinedChart.i,
						});
						return;
					}
					if (combinedChartMap.has(newCombinedChart.i)) {
						const existingCombinedChart = combinedChartMap.get(
							newCombinedChart.i
						);
						existingCombinedChart.c =
							newCombinedChart.c || existingCombinedChart.c;
						existingCombinedChart.d = newCombinedChart.d;
					} else {
						existingCategory.comb = existingCategory.comb || [];
						existingCategory.comb.push(newCombinedChart);
						combinedChartMap.set(newCombinedChart.i, newCombinedChart);
					}
				});
			}

			if (Array.isArray(newCategory.sum) && newCategory.sum.length > 0) {
				existingCategory.sum = existingCategory.sum || [];
				existingCategory.sum.push(...newCategory.sum);
			}

			if (newCategory.chart && typeof newCategory.chart === 'string') {
				existingCategory.chart = newCategory.chart;
			}
			if (Array.isArray(newCategory.ids)) {
				existingCategory.ids = existingCategory.ids || [];
				existingCategory.ids = [
					...new Set([...existingCategory.ids, ...newCategory.ids]),
				];
			}
		} else {
			if (Array.isArray(newCategory.data) && typeof categoryName === 'string') {
				categoryMap.set(categoryName, {
					cat: categoryName,
					data: newCategory.data,
					comb: newCategory.comb || [],
					sum: newCategory.sum || [],
					chart: newCategory.chart || 'Area',
					ids: newCategory.ids || [],
				});
			} else {
				logger.warn('Skipping invalid new category', { index, categoryName });
			}
		}
	});

	const merged = Array.from(categoryMap.values());
	const duration = (Date.now() - startTime) / 1000;
	logger.info('Merged dashboard data', {
		existingCount: existingData.length,
		newCount: newData.length,
		mergedCount: merged.length,
		duration,
	});

	return merged;
};

/**
 * Calculates a dynamic result from user-specified parameters and operations.
 * Removes used parameters and adds result to each category's data array.
 * @param {Array} dashboardData - Array of category objects.
 * @param {Array<string>} parameters - Array of parameter titles (e.g., ["Quantity", "Price"]).
 * @param {Array<string>} operations - Array of operations (e.g., ["multiply"]).
 * @param {string} resultName - Name for the result (e.g., "Total_Cost").
 * @returns {Array} Updated dashboard data with results added.
 */
export function calculateDynamicParameters(
	dashboardData,
	parameters,
	operations,
	resultName
) {
	if (!Array.isArray(dashboardData)) {
		logger.warn('Invalid dashboardData: must be an array', {
			type: typeof dashboardData,
		});
		return dashboardData && Array.isArray(dashboardData)
			? [...dashboardData]
			: [];
	}

	if (!Array.isArray(parameters) || parameters.length < 2) {
		logger.warn('Invalid parameters: at least two required', { parameters });
		return dashboardData;
	}

	if (
		!Array.isArray(operations) ||
		operations.length !== parameters.length - 1
	) {
		logger.warn('Invalid operations: must be one less than parameters', {
			operations,
			expected: parameters.length - 1,
		});
		return dashboardData;
	}

	if (typeof resultName !== 'string' || !resultName.trim()) {
		logger.warn('Invalid resultName: must be a non-empty string', {
			resultName,
		});
		return dashboardData;
	}

	const validOperations = ['plus', 'minus', 'multiply', 'divide'];
	if (!operations.every((op) => validOperations.includes(op))) {
		logger.warn('Invalid operation: must be plus, minus, multiply, or divide', {
			operations,
		});
		return dashboardData;
	}

	const startTime = Date.now();
	const updatedData = dashboardData.map((category, catIndex) => {
		if (
			!category ||
			typeof category !== 'object' ||
			!Array.isArray(category.data)
		) {
			logger.warn('Skipping invalid category', {
				cat: category?.cat,
				catIndex,
			});
			return category;
		}

		const paramData = parameters.map((param, paramIndex) => ({
			param,
			data: category.data.find((d) => d.d[0]?.t === param),
			paramIndex,
		}));

		const values = paramData.map((pd) => pd.data?.d[0]?.v);
		if (
			!values.every((v) => typeof v === 'number' && v !== null && !isNaN(v))
		) {
			if (values.every((v) => typeof v === 'string' && v)) {
				const stringResult = values.join(':');
				const newData = category.data.filter(
					(d) => !parameters.includes(d.d[0]?.t)
				);
				newData.push({
					i: `${category.cat}-${resultName || 'combined_result'}`,
					d: [
						{
							t: resultName || 'Combined_Result',
							v: stringResult,
							d: paramData[0]?.data?.d[0]?.d || new Date(),
						},
					],
				});
				logger.debug('Performed string concatenation', {
					cat: category.cat,
					parameters,
					result: stringResult,
				});
				return {
					...category,
					data: newData,
				};
			}
			logger.debug('Skipping calculation: non-numeric parameters', {
				cat: category.cat,
				parameters,
				values,
			});
			return category;
		}

		let result = values[0];
		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			const nextValue = values[i + 1];
			switch (op) {
				case 'plus':
					result += nextValue;
					break;
				case 'minus':
					result -= nextValue;
					break;
				case 'multiply':
					result *= nextValue;
					break;
				case 'divide':
					result = nextValue !== 0 ? result / nextValue : null;
					break;
			}
			if (result === null || !isFinite(result)) {
				logger.debug('Calculation failed: invalid result', {
					cat: category.cat,
					operation: op,
					values,
					result,
				});
				return category;
			}
		}

		const newData = category.data.filter(
			(d) => !parameters.includes(d.d[0]?.t)
		);
		newData.push({
			i: `${category.cat}-${resultName || 'calculated_result'}`,
			d: [
				{
					t: resultName || 'Calculated_Result',
					v: result,
					d: paramData[0]?.data?.d[0]?.d || new Date(),
				},
			],
		});

		return {
			...category,
			data: newData,
		};
	});

	const duration = (Date.now() - startTime) / 1000;
	logger.info('Calculated dynamic parameters', {
		resultName,
		parameters,
		operations,
		categories: updatedData.length,
		duration,
	});

	return updatedData;
}

/**
 * Limits dashboard data size to a specified maximum (default 8MB).
 * @param {Array} dashboardData - Dashboard data array.
 * @param {number} maxSize - Maximum size in bytes (default: 8MB).
 * @param {Function} [priorityFn] - Optional function to sort categories by priority.
 * @returns {Array} Truncated dashboard data array.
 */
export function limitDashboardDataSize(
	dashboardData,
	maxSize = 8 * 1024 * 1024,
	priorityFn = null
) {
	if (!Array.isArray(dashboardData)) {
		logger.warn('Invalid dashboardData: must be an array', {
			type: typeof dashboardData,
		});
		return [];
	}

	const startTime = Date.now();
	let sortedData = dashboardData;
	if (priorityFn) {
		sortedData = [...dashboardData].sort(priorityFn);
	}

	let totalSize = 0;
	const limitedData = [];

	for (const category of sortedData) {
		const categorySize = Buffer.byteLength(JSON.stringify(category), 'utf8');
		if (totalSize + categorySize <= maxSize) {
			limitedData.push(category);
			totalSize += categorySize;
		} else {
			break;
		}
	}

	if (limitedData.length < sortedData.length) {
		const excludedCategories = sortedData
			.slice(limitedData.length)
			.map((cat) => cat.cat);
		logger.warn('Truncated dashboard data due to size limit', {
			excludedCategories,
			excludedCount: sortedData.length - limitedData.length,
		});
	}

	const duration = (Date.now() - startTime) / 1000;
	logger.info('Limited dashboard data size', {
		originalSize: Buffer.byteLength(JSON.stringify(sortedData), 'utf8'),
		newSize: totalSize,
		keptCategories: limitedData.length,
		duration,
	});

	return limitedData;
}

/**
 * Retrieves titles that are numeric across all categories for dynamic parameter selection.
 * @param {Array} dashboardData - Array of category objects.
 * @returns {Array<string>} Array of numeric titles.
 */
export function getNumericTitles(dashboardData) {
	if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
		logger.warn('Invalid dashboardData: must be an array and non-empty', {
			type: typeof dashboardData,
			length: dashboardData?.length,
		});
		return [];
	}

	const startTime = Date.now();
	const titleMap = new Map();
	let entryCount = 0;

	dashboardData.forEach((category, catIndex) => {
		if (Array.isArray(category.data)) {
			category.data.forEach((entry, entryIndex) => {
				entryCount++;
				const title = entry.d[0]?.t;
				if (title) {
					const isNumeric =
						typeof entry.d[0]?.v === 'number' && !isNaN(entry.d[0]?.v);
					if (!titleMap.has(title)) {
						titleMap.set(title, { numeric: true, count: 0 });
					}
					const titleData = titleMap.get(title);
					titleData.numeric = titleData.numeric && isNumeric;
					titleData.count += 1;
				} else {
					logger.debug('Skipping entry with missing title', {
						category: category.cat,
						catIndex,
						entryIndex,
					});
				}
			});
		}
	});

	const numericTitles = Array.from(titleMap.entries())
		.filter(([_, data]) => data.numeric && data.count === dashboardData.length)
		.map(([title]) => title);

	const duration = (Date.now() - startTime) / 1000;
	logger.info('Retrieved numeric titles', {
		titles: numericTitles,
		count: numericTitles.length,
		entryCount,
		duration,
	});

	return numericTitles;
}
