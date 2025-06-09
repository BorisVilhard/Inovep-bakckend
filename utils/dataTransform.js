import { format } from 'date-fns';
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
 * Transforms a JSON string (from Excel/CSV) into JavaScript code defining a 'data' array.
 * @param {string} documentText - The JSON string representing an array of objects.
 * @returns {string} - A string of valid JavaScript code defining the 'data' array.
 * @throws {Error} - If the input is not a valid JSON string or not an array.
 */
export const transformExcelDataToJSCode = (documentText) => {
	if (typeof documentText !== 'string' || !documentText.trim()) {
		logger.error('Invalid documentText: must be a non-empty string', {
			documentTextSnippet: documentText?.substring(0, 200) || 'undefined',
		});
		throw new Error('Invalid documentText: must be a non-empty string');
	}

	try {
		const data = JSON.parse(documentText);
		if (!Array.isArray(data)) {
			logger.error('Parsed data is not an array', {
				documentTextSnippet: documentText.substring(0, 200),
			});
			throw new Error('Parsed data is not an array of objects');
		}

		const code = `const data = ${JSON.stringify(data, null, 4)};`;
		logger.info('Transformed Excel data to JavaScript code', {
			itemCount: data.length,
		});
		return code;
	} catch (error) {
		logger.error('Error transforming Excel data to JavaScript code', {
			error: error.message,
			documentTextSnippet: documentText.substring(0, 200),
		});
		throw new Error(`Failed to transform data: ${error.message}`);
	}
};

/**
 * Extracts and parses a JavaScript array from a response string.
 * @param {string} response - The response string containing JavaScript code.
 * @returns {Array} - The parsed array of data objects.
 */
export const extractJavascriptCode = (response) => {
	if (typeof response !== 'string' || !response.trim()) {
		logger.error('Invalid response: must be a non-empty string', {
			responseSnippet: response?.substring(0, 200) || 'undefined',
		});
		return [];
	}

	try {
		const jsCodePattern = /const\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
		const match = response.match(jsCodePattern);
		if (!match) {
			logger.warn('No JavaScript array found', {
				responseSnippet: response.substring(0, 200),
			});
			return [];
		}

		let jsArrayString = match[1];
		jsArrayString = jsArrayString
			.replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
			.replace(/(\w+):/g, '"$1":') // Quote unquoted keys
			.replace(/,\s*([\]}])/g, '$1') // Remove trailing commas
			.replace(/([{[,\s])'([^']*)'/g, '$1"$2"'); // Replace single quotes

		const parsedData = JSON.parse(jsArrayString);
		if (!Array.isArray(parsedData)) {
			logger.warn('Parsed data is not an array', {
				responseSnippet: response.substring(0, 200),
			});
			return [];
		}

		logger.info('Extracted JavaScript code', { itemCount: parsedData.length });
		return parsedData;
	} catch (error) {
		logger.error('Error decoding JSON', {
			responseSnippet: response.substring(0, 200),
			error: error.message,
		});

		// Fallback: Recover partial objects
		const partialData = [];
		const objectPattern = /{[^}]*}/g;
		const objects = response.match(objectPattern) || [];
		for (const obj of objects) {
			try {
				const cleanedObj = obj
					.replace(/[\x00-\x1F\x7F-\x9F]/g, '')
					.replace(/(\w+):/g, '"$1":')
					.replace(/,\s*}/g, '}')
					.replace(/([{[,\s])'([^']*)'/g, '$1"$2"');
				partialData.push(JSON.parse(cleanedObj));
			} catch (e) {
				logger.debug('Failed to parse partial object', {
					obj: obj.substring(0, 100),
					error: e.message,
				});
			}
		}

		logger.info('Recovered partial data', { itemCount: partialData.length });
		return partialData;
	}
};

/**
 * Transforms raw data into the DashboardCategorySchema structure.
 * @param {Array} data - Array of data objects from the uploaded file.
 * @param {string} fileName - Name of the uploaded file.
 * @returns {Object} - Object containing dashboardData array.
 */
export function transformDataStructure(data, fileName) {
	if (
		!Array.isArray(data) ||
		typeof fileName !== 'string' ||
		!fileName.trim()
	) {
		logger.warn(
			'Invalid input: data must be an array and fileName a non-empty string',
			{
				fileName: fileName || 'undefined',
				dataType: typeof data,
			}
		);
		return { dashboardData: [] };
	}

	const dashboardData = [];
	const fallbackDate = format(new Date(), 'yyyy-MM-dd');
	const dateRegex = /^\d{4}-\d{2}(?:-\d{2})?$/;
	const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 1000;

	if (data.length === 0) {
		logger.warn('No valid data provided', { fileName });
		return { dashboardData };
	}

	const isStringValue = (val) => {
		if (typeof val !== 'string' || !val.trim()) return false;
		if (!isNaN(parseFloat(val)) && isFinite(val)) return false;
		if (dateRegex.test(val.trim())) return false;
		return true;
	};

	// Prioritize columns like 'Notes' or 'Description' for categoryName
	const preferredColumns = ['Notes', 'Description', 'Comments'];
	let stringColumnKey = null;
	const keys = Object.keys(data[0] || {});
	logger.info('Available columns', { fileName, columns: keys });

	if (keys.length > 0) {
		// First, try preferred columns
		for (const key of preferredColumns) {
			if (
				keys.includes(key) &&
				data.every((item) => item[key] && isStringValue(item[key]))
			) {
				stringColumnKey = key;
				break;
			}
		}
		// If no preferred column found, fall back to any string column
		if (!stringColumnKey) {
			for (const key of keys) {
				if (data.every((item) => item[key] && isStringValue(item[key]))) {
					stringColumnKey = key;
					break;
				}
			}
		}
	}
	logger.info('Selected string column key', { fileName, stringColumnKey });

	for (let i = 0; i < data.length; i += BATCH_SIZE) {
		const batch = data.slice(i, i + BATCH_SIZE);
		batch.forEach((item, index) => {
			if (!item || typeof item !== 'object') {
				logger.warn('Skipping invalid item', {
					fileName,
					itemIndex: i + index,
				});
				return;
			}

			const itemKeys = Object.keys(item);
			if (itemKeys.length === 0) {
				logger.warn('Skipping empty item', { fileName, itemIndex: i + index });
				return;
			}

			let detectedDate = null;
			for (const key of itemKeys) {
				const val = item[key];
				if (typeof val === 'string' && dateRegex.test(val.trim())) {
					const trimmed = val.trim();
					detectedDate = trimmed.length === 7 ? trimmed + '-01' : trimmed;
					break;
				}
			}

			let categoryName =
				stringColumnKey &&
				item[stringColumnKey] &&
				isStringValue(item[stringColumnKey])
					? String(item[stringColumnKey]).trim()
					: itemKeys.length > 0
					? String(item[itemKeys[0]] || 'Unknown').trim()
					: 'Unknown';

			const charts = [];
			for (const key of itemKeys) {
				if (key === stringColumnKey) continue;
				const chartTitle = String(key).trim() || 'unknown_column';
				const value = item[key];
				let chartValue =
					typeof value === 'string' && !dateRegex.test(value.trim())
						? cleanNumeric(value)
						: value;

				if (chartValue === undefined || chartValue === null) {
					logger.debug('Skipping invalid chart value', { fileName, key });
					continue;
				}

				const chartId = generateChartId(categoryName, chartTitle);
				charts.push({
					chartType: 'Area',
					id: chartId,
					data: [
						{
							title: chartTitle,
							value: chartValue,
							date: detectedDate || fallbackDate,
							fileName,
						},
					],
					isChartTypeChanged: false,
					fileName,
				});
			}

			if (charts.length === 0) {
				logger.warn('No valid charts generated for item', {
					fileName,
					itemIndex: i + index,
				});
				return;
			}

			dashboardData.push({
				categoryName,
				mainData: charts,
				combinedData: [],
			});
		});
	}

	logger.info('Transformed data structure', {
		fileName,
		categoryCount: dashboardData.length,
		sampleDashboardData: dashboardData.slice(0, 3),
	});

	return { dashboardData };
}

/**
 * Cleans string values into numeric format if possible.
 * @param {any} value - The value to clean.
 * @returns {number|string|any} - The cleaned numeric value or original value.
 */
export function cleanNumeric(value) {
	if (typeof value !== 'string' || !value.trim()) return value;

	const numMatch = value.match(/-?\d+(\.\d+)?/);
	if (numMatch) {
		const numStr = numMatch[0];
		return numStr.includes('.') ? parseFloat(numStr) : parseInt(numStr, 10);
	}

	return value;
}

/**
 * Generates a unique chart ID based on category name and chart title.
 * @param {string} categoryName - The category name.
 * @param {string} chartTitle - The chart title.
 * @returns {string} - The generated chart ID.
 */
export function generateChartId(categoryName, chartTitle) {
	const safeCategoryName =
		typeof categoryName === 'string'
			? categoryName.trim()
			: String(categoryName || 'unknown');
	const safeChartTitle =
		typeof chartTitle === 'string'
			? chartTitle.trim()
			: String(chartTitle || 'unknown');

	const id = `${safeCategoryName
		.toLowerCase()
		.replace(/\s+/g, '-')}-${safeChartTitle
		.toLowerCase()
		.replace(/\s+/g, '-')}`;

	logger.debug('Generated chart ID', {
		categoryName: safeCategoryName,
		chartTitle: safeChartTitle,
		id,
	});
	return id;
}
