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
		return Array.isArray(existingData) ? [...existingData] : [];
	}

	const startTime = Date.now();
	const categoryMap = new Map();

	// Map existing categories
	existingData.forEach((category, index) => {
		const categoryName = category.cat || category.categoryName;
		if (typeof categoryName !== 'string' || !categoryName.trim()) {
			logger.warn('Skipping invalid category', { index, categoryName });
			return;
		}
		categoryMap.set(categoryName, { ...category, cat: categoryName });
	});

	// Merge new categories
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

			// Merge data entries
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
						!newEntry.d.every(
							(node) =>
								typeof node.t === 'string' &&
								node.v !== undefined &&
								node.d instanceof Date
						)
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

			// Merge combined charts
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

			// Merge summaries
			if (Array.isArray(newCategory.sum) && newCategory.sum.length > 0) {
				existingCategory.sum = existingCategory.sum || [];
				existingCategory.sum.push(...newCategory.sum);
			}

			// Update chart and IDs
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
 * Processes categories one by one to avoid memory issues with large datasets.
 * Removes used parameters and adds result to each category's data array.
 * @param {Array} dashboardData - Array of category objects.
 * @param {Array<string>} parameters - Array of parameter titles (e.g., ["DischargeDate", "AdmissionDate"]).
 * @param {Array<string>} operations - Array of operations (e.g., ["minus"]).
 * @param {string} resultName - Name for the result (e.g., "Days_spent").
 * @param {string} calculationType - Type of calculation (default: 'numeric').
 * @returns {Array} Updated dashboard data with results added.
 */
export function calculateDynamicParameters(
	dashboardData,
	parameters,
	operations,
	resultName,
	calculationType = 'numeric'
) {
	// Input validation
	if (!Array.isArray(dashboardData)) {
		logger.warn('Invalid dashboardData: must be an array', {
			type: typeof dashboardData,
		});
		return Array.isArray(dashboardData) ? [...dashboardData] : [];
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

	// Validate operations based on calculation type
	const validOperations =
		calculationType === 'numeric'
			? ['plus', 'minus', 'multiply', 'divide']
			: ['minus'];
	if (!operations.every((op) => validOperations.includes(op))) {
		logger.warn(`Invalid operation: must be ${validOperations.join(', ')}`, {
			operations,
			calculationType,
		});
		return dashboardData;
	}

	if (
		calculationType === 'date' &&
		(parameters.length !== 2 || operations[0] !== 'minus')
	) {
		logger.warn(
			'Date calculation requires exactly two parameters and minus operation',
			{ parameters, operations }
		);
		return dashboardData;
	}

	const startTime = Date.now();
	const updatedData = [];

	// Process categories one by one
	for (const [catIndex, category] of dashboardData.entries()) {
		// Validate category structure
		if (
			!category ||
			typeof category !== 'object' ||
			!Array.isArray(category.data)
		) {
			logger.warn('Skipping invalid category', {
				cat: category?.cat,
				catIndex,
			});
			updatedData.push(category);
			continue;
		}

		// Find parameter entries
		const paramData = parameters.map((param, paramIndex) => ({
			param,
			data: category.data.find((d) => d.d[0]?.t === param),
			paramIndex,
		}));

		// Skip if any parameter is missing
		if (!paramData.every((pd) => pd.data)) {
			logger.debug('Skipping category: missing parameters', {
				cat: category.cat,
				parameters,
				missing: parameters.filter(
					(p) => !category.data.some((d) => d.d[0]?.t === p)
				),
			});
			updatedData.push(category);
			continue;
		}

		if (calculationType === 'date') {
			// Handle date difference calculation
			const [date1, date2] = paramData.map((pd) => pd.data.d[0]?.v);
			let result = null;

			// Convert values to Date objects if necessary
			const d1 = date1 instanceof Date ? date1 : new Date(date1);
			const d2 = date2 instanceof Date ? date2 : new Date(date2);

			if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
				// Calculate difference in days
				result = (d1 - d2) / (1000 * 60 * 60 * 24);
			}

			if (result === null || !isFinite(result)) {
				logger.debug('Date calculation failed: invalid dates', {
					cat: category.cat,
					parameters,
					values: [date1, date2],
				});
				updatedData.push(category);
				continue;
			}

			// Create new entry
			const newData = category.data.filter(
				(d) => !parameters.includes(d.d[0]?.t)
			);
			newData.push({
				i: `${category.cat}-${resultName || 'date_diff'}`,
				d: [
					{
						t: resultName || 'Date_Diff',
						v: result,
						d:
							paramData[0]?.data?.d[0]?.d instanceof Date
								? paramData[0].data.d[0].d
								: new Date(paramData[0]?.data?.d[0]?.d || Date.now()),
					},
				],
			});

			logger.debug('Performed date calculation', {
				cat: category.cat,
				parameters,
				result,
			});

			updatedData.push({
				...category,
				data: newData,
			});
			continue;
		}

		// Handle numeric calculation
		const values = paramData.map((pd) => {
			const value = pd.data?.d[0]?.v;
			return typeof value === 'number' ? value : parseFloat(value) || 0;
		});

		// Validate numeric values
		if (!values.every((v) => typeof v === 'number' && !isNaN(v))) {
			// Handle string concatenation if all values are strings
			if (values.every((v) => typeof v === 'string' && v)) {
				const result = values.join('');
				const newData = category.data.filter(
					(d) => !parameters.includes(d.d[0]?.t)
				);
				newData.push({
					i: `${category.cat}-${resultName || 'combined_result'}`,
					d: [
						{
							t: resultName || 'Combined_Result',
							v: result,
							d:
								paramData[0]?.data?.d[0]?.d instanceof Date
									? paramData[0].data.d[0].d
									: new Date(paramData[0]?.data?.d[0]?.d || Date.now()),
						},
					],
				});

				logger.debug('Performed string concatenation', {
					cat: category.cat,
					parameters,
					result,
				});

				updatedData.push({
					...category,
					data: newData,
				});
				continue;
			}

			logger.debug('Skipping calculation: non-numeric parameters', {
				cat: category.cat,
				parameters,
				values,
			});
			updatedData.push(category);
			continue;
		}

		// Perform numeric calculation
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
				default:
					logger.warn('Unknown operation', {
						operation: op,
						cat: category.cat,
					});
					updatedData.push(category);
					continue;
			}
			if (result === null || !isFinite(result)) {
				logger.debug('Calculation failed: invalid result', {
					cat: category.cat,
					operation: op,
					values,
					result,
				});
				updatedData.push(category);
				continue;
			}
		}

		// Create new entry
		const newData = category.data.filter(
			(d) => !parameters.includes(d.d[0]?.t)
		);
		newData.push({
			i: `${category.cat}-${resultName || 'calculated_result'}`,
			d: [
				{
					t: resultName || 'Calculated_Result',
					v: result,
					d:
						paramData[0]?.data?.d[0]?.d instanceof Date
							? paramData[0].data.d[0].d
							: new Date(paramData[0]?.data?.d[0]?.d || Date.now()),
				},
			],
		});

		logger.debug('Performed numeric calculation', {
			cat: category.cat,
			parameters,
			operation: operations[0],
			result,
		});

		updatedData.push({
			...category,
			data: newData,
		});
	}

	const duration = (Date.now() - startTime) / 1000;
	logger.info('Calculated dynamic parameters', {
		resultName,
		parameters,
		operations,
		calculationType,
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
	if (priorityFn && typeof priorityFn === 'function') {
		try {
			sortedData = [...dashboardData].sort(priorityFn);
		} catch (e) {
			logger.warn('Priority function failed, using unsorted data', {
				error: e.message,
			});
		}
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
	return dashboardData
		.flatMap((category) => category.data.map((entry) => entry.d[0]?.t))
		.filter(
			(t, i, arr) =>
				t &&
				typeof dashboardData[0].data.find((e) => e.d[0]?.t === t)?.d[0]?.v ===
					'number' &&
				arr.indexOf(t) === i
		);
}

/**
 * Retrieves titles that are dates across all categories for dynamic parameter selection.
 * @param {Array} dashboardData - Array of category objects.
 * @returns {Array<string>} Array of date titles.
 */
export function getDateTitles(dashboardData) {
	if (!Array.isArray(dashboardData) || dashboardData.length === 0) {
		logger.warn('Invalid dashboardData for date titles', {
			type: typeof dashboardData,
			length: dashboardData?.length,
		});
		return [];
	}

	const titleMap = new Map();
	let entryCount = 0;

	dashboardData.forEach((category, catIndex) => {
		if (!Array.isArray(category.data)) return;
		category.data.forEach((entry, entryIndex) => {
			entryCount++;
			const title = entry.d[0]?.t;
			if (title) {
				const value = entry.d[0]?.v;
				const isDate =
					value instanceof Date ||
					(typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value));
				if (!titleMap.has(title)) {
					titleMap.set(title, { isDate: true, count: 0 });
				}
				const titleData = titleMap.get(title);
				titleData.isDate = titleData.isDate && isDate;
				titleData.count += 1;
			}
		});
	});

	const dateTitles = Array.from(titleMap.entries())
		.filter(([_, data]) => data.isDate && data.count >= dashboardData.length)
		.map(([title]) => title);

	logger.info('Retrieved date titles', {
		titles: dateTitles,
		count: dateTitles.length,
		entryCount,
	});

	return dateTitles;
}
