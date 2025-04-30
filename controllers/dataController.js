import mongoose from 'mongoose';
import { PdfReader } from 'pdfreader';
import { format } from 'date-fns';
import sharp from 'sharp';
import tesseract from 'tesseract.js';
import xlsx from 'xlsx';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { Readable } from 'stream';
import { parse } from 'csv-parse';
import { mergeDashboardData } from '../utils/dashboardUtils.js';
import { transformExcelDataToJSCode } from '../utils/transformExcel.js';
import { getGoogleDriveModifiedTime } from '../utils/googleDriveService.js';
import { getUserAuthClient } from '../utils/oauthService.js';
import { getTokens } from '../tokenStore.js';
import { google } from 'googleapis';
import Dashboard from '../model/Data.js';

// In-memory store for chunks
const chunkStore = new Map(); // { chunkId: { chunks: Buffer[], totalChunks: number, fileName: string, fileType: string } }

/**
 * Middleware: Verify that the user making the request owns the resource.
 */
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user.id;
	const userIdFromParams = req.params.id;
	if (userIdFromToken !== userIdFromParams) {
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
};

/**
 * GET /users/:id/dashboard
 * Retrieves all dashboards for the given user.
 */
export const getAllDashboards = async (req, res) => {
	const userId = req.params.id;
	try {
		const dashboards = await Dashboard.find({ userId });
		if (!dashboards || dashboards.length === 0) {
			return res.status(204).json({ message: 'No dashboards found' });
		}
		res.json(dashboards);
	} catch (error) {
		console.error('Error fetching dashboards:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId
 * Retrieves a specific dashboard.
 */
export const getDashboardById = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		res.json(dashboard);
	} catch (error) {
		console.error('Error fetching dashboard:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * POST /users/:id/dashboard/create
 * Creates a new dashboard.
 */
export const createDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardName } = req.body;
	if (!dashboardName) {
		return res.status(400).json({ message: 'dashboardName is required' });
	}
	try {
		const existingDashboard = await Dashboard.findOne({
			dashboardName,
			userId,
		});
		if (existingDashboard) {
			return res.status(400).json({ message: 'Dashboard name already exists' });
		}
		const dashboard = new Dashboard({
			dashboardName,
			dashboardData: [],
			files: [],
			userId,
		});
		await dashboard.save();
		res
			.status(201)
			.json({ message: 'Dashboard created successfully', dashboard });
	} catch (error) {
		console.error('Error creating dashboard:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId
 * Updates an existing dashboard.
 */
export const updateDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	const { dashboardData, dashboardName } = req.body;
	if (!dashboardData && !dashboardName) {
		return res
			.status(400)
			.json({ message: 'dashboardData or dashboardName is required' });
	}
	try {
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboard ID' });
		}
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		if (dashboardName && dashboardName !== dashboard.dashboardName) {
			const existingDashboard = await Dashboard.findOne({
				dashboardName,
				userId,
			});
			if (existingDashboard) {
				return res
					.status(400)
					.json({ message: 'Dashboard name already exists' });
			}
			dashboard.dashboardName = dashboardName;
		}
		if (dashboardData) {
			dashboard.dashboardData = dashboardData;
		}
		await dashboard.save();
		res.json({ message: 'Dashboard updated successfully', dashboard });
	} catch (error) {
		console.error('Error updating dashboard:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId
 * Deletes a dashboard.
 */
export const deleteDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
		return res.status(400).json({ message: 'Invalid dashboard ID' });
	}
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		await dashboard.deleteOne();
		res.json({ message: 'Dashboard deleted successfully' });
	} catch (error) {
		console.error('Error deleting dashboard:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/file/:fileName
 * Removes data associated with a file from the dashboard.
 */
export const deleteDataByFileName = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, fileName } = req.params;
	if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
		return res.status(400).json({ message: 'Invalid dashboard ID' });
	}
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		dashboard.files = dashboard.files.filter(
			(file) => file.filename !== fileName
		);
		dashboard.dashboardData.forEach((category) => {
			category.mainData = category.mainData.filter((chart) => {
				chart.data = chart.data.filter(
					(dataPoint) => dataPoint.fileName !== fileName
				);
				return chart.data.length > 0;
			});
		});
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(category) => category.mainData.length > 0
		);
		await dashboard.save();
		res.json({ message: 'Data deleted successfully', dashboard });
	} catch (error) {
		console.error('Error deleting data:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId/files
 * Retrieves an array of file names associated with the dashboard.
 */
export const getDashboardFiles = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		const files = dashboard.files.map((file) => file.filename);
		res.json({ files });
	} catch (error) {
		console.error('Error fetching dashboard files:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * Extracts text from a document based on its type using memory-based processing.
 */
const getDocumentText = async (buffer, fileType) => {
	let text = '';
	if (fileType === 'application/pdf') {
		const pdfReader = new PdfReader();
		return new Promise((resolve, reject) => {
			pdfReader.parseBuffer(buffer, (err, item) => {
				if (err) {
					console.error('Error parsing PDF:', err);
					reject(err);
				} else if (!item) {
					resolve(text);
				} else if (item.text) {
					text += item.text + ' ';
				}
			});
		});
	} else if (fileType === 'image/png' || fileType === 'image/jpeg') {
		const image = sharp(buffer);
		const imageBuffer = await image.toBuffer();
		const result = await tesseract.recognize(imageBuffer);
		text = result.data.text;
		return text;
	} else if (
		fileType ===
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		fileType === 'application/vnd.ms-excel' ||
		fileType === 'text/csv'
	) {
		const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = xlsx.utils.sheet_to_json(sheet);
		text = JSON.stringify(data);
		return text;
	} else {
		throw new Error('Unsupported file type');
	}
};

function cleanNumeric(value) {
	if (typeof value === 'string') {
		const numMatch = value.match(/-?\d+(\.\d+)?/);
		if (numMatch) {
			const numStr = numMatch[0];
			return numStr.includes('.') ? parseFloat(numStr) : parseInt(numStr, 10);
		}
	}
	return value;
}

function generateChartId(categoryName, chartTitle) {
	if (typeof categoryName !== 'string') {
		console.error('categoryName is not a string:', categoryName);
		categoryName = String(categoryName);
	}
	if (typeof chartTitle !== 'string') {
		console.error('chartTitle is not a string:', chartTitle);
		chartTitle = String(chartTitle);
	}
	return `${categoryName.toLowerCase().replace(/\s+/g, '-')}-${chartTitle
		.toLowerCase()
		.replace(/\s+/g, '-')}`;
}

function extractJavascriptCode(response) {
	try {
		// Validate response format
		if (!response.startsWith('const data = [')) {
			console.error('Invalid AI response format:', response.substring(0, 200));
			return [];
		}

		// Extract the JavaScript array from the response
		const jsCodePattern = /const\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
		const match = response.match(jsCodePattern);
		if (!match) {
			console.error('No JavaScript array found in response:', response);
			return [];
		}

		let jsArrayString = match[1];
		console.log(
			'Raw extracted JavaScript array:',
			jsArrayString.substring(0, 200)
		);

		// Protect ISO date strings by wrapping them in a placeholder
		const datePlaceholder = '__ISO_DATE__';
		const dateMap = new Map();
		let dateCounter = 0;
		jsArrayString = jsArrayString.replace(
			/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/g,
			(match) => {
				const placeholder = `${datePlaceholder}${dateCounter++}`;
				dateMap.set(placeholder, match);
				return placeholder;
			}
		);

		// Clean the string to produce valid JSON
		jsArrayString = jsArrayString
			// Remove comments
			.replace(/\/\/.*?\n/g, '')
			// Convert unquoted keys to quoted keys
			.replace(/(\w+):/g, '"$1":')
			// Replace single quotes with double quotes
			.replace(/'/g, '"')
			// Replace null/undefined with "null"
			.replace(/\b(null|undefined)\b/g, '"null"')
			// Remove trailing commas before closing brackets/objects
			.replace(/,\s*\]/g, ']')
			.replace(/,\s*\}/g, '}')
			// Normalize whitespace
			.replace(/\s+/g, ' ')
			// Fix object separation
			.replace(/\}\s*\{/g, '},{')
			// Remove trailing commas
			.replace(/,(\s*[\]\}])/g, '$1');

		// Restore ISO date strings
		dateMap.forEach((date, placeholder) => {
			jsArrayString = jsArrayString.replace(`"${placeholder}"`, `"${date}"`);
		});

		console.log('Cleaned JavaScript array:', jsArrayString.substring(0, 200));

		// Validate JSON syntax before parsing
		try {
			JSON.parse(jsArrayString);
		} catch (syntaxError) {
			console.error('Invalid JSON syntax after cleaning:', syntaxError, {
				jsArrayStringSnippet: jsArrayString.substring(0, 200),
			});
			throw syntaxError;
		}

		const parsedData = JSON.parse(jsArrayString);
		if (!Array.isArray(parsedData)) {
			console.error('Parsed data is not an array:', parsedData);
			return [];
		}
		console.log('Successfully parsed data:', parsedData.length, 'items');
		return parsedData;
	} catch (error) {
		console.error('Error decoding JSON:', error, {
			responseSnippet: response.substring(Math.max(0, response.length - 100)),
			fullResponseLength: response.length,
		});

		// Fallback: Attempt to extract partial valid JSON
		try {
			const partialMatch = response.match(/\[[\s\S]*?\]/);
			if (partialMatch) {
				let partialString = partialMatch[0];
				const dateMap = new Map();
				let dateCounter = 0;
				partialString = partialString.replace(
					/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\b/g,
					(match) => {
						const placeholder = `__ISO_DATE__${dateCounter++}`;
						dateMap.set(placeholder, match);
						return placeholder;
					}
				);
				partialString = partialString
					.replace(/\/\/.*?\n/g, '')
					.replace(/(\w+):/g, '"$1":')
					.replace(/'/g, '"')
					.replace(/\b(null|undefined)\b/g, '"null"')
					.replace(/,\s*\]/g, ']')
					.replace(/,\s*\}/g, '}')
					.replace(/\s+/g, ' ')
					.replace(/\}\s*\{/g, '},{')
					.replace(/,(\s*[\]\}])/g, '$1');
				dateMap.forEach((date, placeholder) => {
					partialString = partialString.replace(
						`"${placeholder}"`,
						`"${date}"`
					);
				});
				const partialData = JSON.parse(partialString);
				if (Array.isArray(partialData)) {
					console.log('Recovered partial data:', partialData.length, 'items');
					return partialData;
				}
			}
		} catch (partialError) {
			console.error('Failed to recover partial data:', partialError);
		}
		return [];
	}
}

function transformDataStructure(data, fileName) {
	const dashboardData = [];
	const fallbackDate = format(new Date(), 'yyyy-MM-dd');
	const dateRegex = /^\d{4}-\d{2}(?:-\d{2})?$/;
	const BATCH_SIZE = 1000;

	if (!Array.isArray(data) || data.length === 0) {
		console.warn('transformDataStructure: No valid data provided', { data });
		return { dashboardData };
	}

	const isStringValue = (val) => {
		if (typeof val !== 'string') return false;
		if (!isNaN(parseFloat(val)) && isFinite(val)) return false;
		if (dateRegex.test(val.trim())) return false;
		return true;
	};

	let stringColumnKey = null;
	const keys = Object.keys(data[0] || {});
	if (keys.length > 0) {
		for (const key of keys) {
			const allStrings = data.every((item) => isStringValue(item[key]));
			if (allStrings) {
				stringColumnKey = key;
				break;
			}
		}
	}

	if (stringColumnKey) {
		console.log('Selected string column for categoryName:', stringColumnKey);
	} else {
		console.warn('No string column found, using fallback');
	}

	for (let i = 0; i < data.length; i += BATCH_SIZE) {
		console.log(
			`Processing batch ${i / BATCH_SIZE + 1} of ${Math.ceil(
				data.length / BATCH_SIZE
			)}`
		);
		const batch = data.slice(i, i + BATCH_SIZE);
		batch.forEach((item) => {
			if (!item || typeof item !== 'object') {
				console.warn('Skipping invalid item in data', { item });
				return;
			}

			const keys = Object.keys(item);
			let detectedDate = null;
			let detectedDateKey = null;

			for (const key of keys) {
				const val = item[key];
				if (typeof val === 'string' && dateRegex.test(val.trim())) {
					const trimmed = val.trim();
					detectedDate = trimmed.length === 7 ? trimmed + '-01' : trimmed;
					detectedDateKey = key;
					break;
				}
			}

			let categoryName;
			if (
				stringColumnKey &&
				item[stringColumnKey] &&
				String(item[stringColumnKey]).trim()
			) {
				categoryName = String(item[stringColumnKey]).trim();
			} else {
				categoryName = keys.length > 0 ? String(item[keys[0]]) : 'Unknown';
			}

			const charts = [];
			for (const key of keys) {
				if (key === stringColumnKey) continue;
				const chartTitle = String(key);
				const value = item[key];
				let chartValue = value;
				if (typeof value === 'string' && !dateRegex.test(value.trim())) {
					chartValue = cleanNumeric(value);
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
							fileName: fileName,
						},
					],
					isChartTypeChanged: false,
					fileName: fileName,
				});
			}

			dashboardData.push({
				categoryName: categoryName,
				mainData: charts,
				combinedData: [],
			});
		});
	}

	return { dashboardData };
}

export const updateChartType = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, chartId } = req.params;
	const { chartType } = req.body;
	if (!chartType) {
		return res.status(400).json({ message: 'chartType is required' });
	}
	try {
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboard ID' });
		}
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		let chartFound = false;
		for (let category of dashboard.dashboardData) {
			for (let chart of category.mainData) {
				if (chart.id === chartId) {
					chart.chartType = chartType;
					chart.isChartTypeChanged = true;
					chartFound = true;
					break;
				}
			}
			if (chartFound) break;
		}
		if (!chartFound) {
			return res.status(404).json({ message: `Chart ID ${chartId} not found` });
		}
		await dashboard.save();
		res.json({ message: 'ChartType updated successfully', dashboard });
	} catch (error) {
		console.error('Error updating chartType:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId/category/:categoryName
 * Updates a dashboard category’s data.
 */
export const updateCategoryData = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryName } = req.params;
	const { combinedData, summaryData, appliedChartType, checkedIds } = req.body;
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryName
		);
		if (!category) {
			return res
				.status(404)
				.json({ message: `Category ${categoryName} not found` });
		}
		if (combinedData) category.combinedData = combinedData;
		if (summaryData) category.summaryData = summaryData;
		if (appliedChartType) category.appliedChartType = appliedChartType;
		if (checkedIds) category.checkedIds = checkedIds;
		await dashboard.save();
		res.json({ message: 'Category data updated successfully', dashboard });
	} catch (error) {
		console.error('Error updating category data:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * POST /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart
 * Creates a CombinedChart by aggregating data from multiple charts.
 */
export const addCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId } = req.params;
	const { chartType, chartIds } = req.body;
	if (
		!chartType ||
		!chartIds ||
		!Array.isArray(chartIds) ||
		chartIds.length < 2
	) {
		return res.status(400).json({
			message:
				'chartType and at least two chartIds are required to create a CombinedChart',
		});
	}
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}
		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}
		const validChartIds = category.mainData.map((chart) => chart.id);
		const isValid = chartIds.every((id) => validChartIds.includes(id));
		if (!isValid) {
			return res
				.status(400)
				.json({ message: 'One or more chartIds are invalid' });
		}
		let aggregatedEntries = [];
		category.mainData.forEach((chart) => {
			if (chartIds.includes(chart.id)) {
				aggregatedEntries = [...aggregatedEntries, ...chart.data];
			}
		});
		const combinedChartId = `combined-${Date.now()}`;
		const combinedChart = {
			id: combinedChartId,
			chartType,
			chartIds,
			data: aggregatedEntries,
		};
		category.combinedData.push(combinedChart);
		await dashboard.save();
		res
			.status(201)
			.json({ message: 'CombinedChart created successfully', combinedChart });
	} catch (error) {
		console.error('Error adding CombinedChart:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * DELETE /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId
 * Deletes a CombinedChart.
 */
export const deleteCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}
		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}
		const index = category.combinedData.findIndex(
			(chart) => chart.id === combinedChartId
		);
		if (index === -1) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}
		category.combinedData.splice(index, 1);
		await dashboard.save();
		res.status(200).json({ message: 'CombinedChart deleted successfully' });
	} catch (error) {
		console.error('Error deleting CombinedChart:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * PUT /users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId
 * Updates an existing CombinedChart.
 */
export const updateCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;
	const { chartType, chartIds } = req.body;
	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}
		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryId
		);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}
		const combinedChart = category.combinedData.find(
			(chart) => chart.id === combinedChartId
		);
		if (!combinedChart) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}
		if (chartType) combinedChart.chartType = chartType;
		if (chartIds) {
			if (!Array.isArray(chartIds) || chartIds.length < 2) {
				return res
					.status(400)
					.json({ message: 'At least two chartIds are required' });
			}
			const validChartIds = category.mainData.map((chart) => chart.id);
			const isValid = chartIds.every((id) => validChartIds.includes(id));
			if (!isValid) {
				return res
					.status(400)
					.json({ message: 'One or more chartIds are invalid' });
			}
			combinedChart.chartIds = chartIds;
			let aggregatedEntries = [];
			category.mainData.forEach((chart) => {
				if (chartIds.includes(chart.id)) {
					aggregatedEntries = [...aggregatedEntries, ...chart.data];
				}
			});
			combinedChart.data = aggregatedEntries;
		}
		await dashboard.save();
		res
			.status(200)
			.json({ message: 'CombinedChart updated successfully', combinedChart });
	} catch (error) {
		console.error('Error updating CombinedChart:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * POST /users/:id/dashboard/upload-chunk
 * Receives and stores a file chunk in memory.
 */
export const uploadChunk = async (req, res) => {
	try {
		const userId = req.params.id;
		const { chunkId, chunkIndex, totalChunks, fileName, fileType } = req.body;

		if (
			!req.file ||
			!chunkId ||
			!chunkIndex ||
			!totalChunks ||
			!fileName ||
			!fileType
		) {
			return res
				.status(400)
				.json({ message: 'Missing required chunk metadata' });
		}

		// Validate file type
		const allowedTypes = [
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'text/csv',
		];
		if (!allowedTypes.includes(fileType)) {
			return res.status(400).json({
				message: 'Unsupported file type',
				receivedType: fileType,
				allowedTypes,
			});
		}

		// Store chunk in memory
		const chunkIndexNum = parseInt(chunkIndex, 10);
		if (!chunkStore.has(chunkId)) {
			chunkStore.set(chunkId, {
				chunks: new Array(parseInt(totalChunks, 10)).fill(null),
				totalChunks: parseInt(totalChunks, 10),
				fileName,
				fileType,
			});
		}

		const chunkData = chunkStore.get(chunkId);
		if (chunkIndexNum >= chunkData.totalChunks) {
			return res.status(400).json({ message: 'Invalid chunk index' });
		}

		chunkData.chunks[chunkIndexNum] = req.file.buffer;

		console.log('Chunk received:', {
			chunkId,
			chunkIndex,
			totalChunks,
			fileName,
			fileType,
			chunkSize: req.file.buffer.length,
		});

		res.status(200).json({
			message: 'Chunk received successfully',
			chunkId,
			chunkIndex,
		});
	} catch (error) {
		console.error('Error in uploadChunk:', error);
		if (error.message.includes('Bad compressed size')) {
			res.status(400).json({ error: 'Invalid or corrupted Excel/CSV file' });
		} else {
			res.status(500).json({ error: error.message });
		}
	}
};

/**
 * POST /users/:id/dashboard/finalize-chunk
 * Reassembles chunks from memory, processes the file, and updates the dashboard.
 */
export const finalizeChunk = async (req, res) => {
	try {
		const userId = req.params.id;
		const { chunkId, dashboardId, fileName, totalChunks } = req.body;

		if (!chunkId || !dashboardId || !fileName || !totalChunks) {
			return res.status(400).json({
				message: 'Missing required finalize metadata',
			});
		}

		// Validate dashboard
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboard ID' });
		}

		let dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Retrieve and validate chunks from memory
		if (!chunkStore.has(chunkId)) {
			return res.status(400).json({ message: 'Chunk ID not found' });
		}

		const chunkData = chunkStore.get(chunkId);
		if (chunkData.totalChunks !== parseInt(totalChunks, 10)) {
			return res.status(400).json({ message: 'Mismatched total chunks' });
		}

		if (chunkData.chunks.some((chunk) => chunk === null)) {
			return res.status(400).json({ message: 'Incomplete chunks received' });
		}

		// Reassemble chunks
		const fileBuffer = Buffer.concat(chunkData.chunks);

		// Process reassembled file
		let chunkDataParsed = [];
		if (fileName.endsWith('.csv')) {
			const parser = parse({ columns: true, trim: true });
			const chunkStream = Readable.from(fileBuffer);
			for await (const row of chunkStream.pipe(parser)) {
				chunkDataParsed.push(row);
			}
		} else {
			const workbook = xlsx.read(fileBuffer, {
				type: 'buffer',
				cellDates: true,
			});
			const sheetName = workbook.SheetNames[0];
			if (!sheetName) {
				return res.status(400).json({ error: 'Excel/CSV file has no sheets' });
			}
			const sheet = workbook.Sheets[sheetName];
			if (!sheet) {
				return res
					.status(400)
					.json({ error: 'Invalid sheet in Excel/CSV file' });
			}
			chunkDataParsed = xlsx.utils.sheet_to_json(sheet, { raw: true });
			if (!chunkDataParsed || !Array.isArray(chunkDataParsed)) {
				return res
					.status(400)
					.json({ error: 'No valid data extracted from Excel/CSV file' });
			}
		}

		// Transform chunk data
		let documentText = JSON.stringify(chunkDataParsed);
		let response;
		try {
			response = transformExcelDataToJSCode(documentText);
			console.log('AI transformation response length:', response.length);
		} catch (transformError) {
			console.error('Error transforming chunk data:', transformError);
			return res.status(500).json({
				error: `Data transformation failed: ${transformError.message}`,
			});
		}

		const extractedData = extractJavascriptCode(response);
		console.log('Extracted data items:', extractedData.length);

		const formedData = transformDataStructure(extractedData, fileName);
		const { dashboardData: transformedDashboardData } = formedData;

		if (!transformedDashboardData || transformedDashboardData.length === 0) {
			return res
				.status(400)
				.json({ message: 'No valid dashboard data extracted from chunk' });
		}

		// Save aggregated dashboard data
		const fileData = {
			filename: fileName,
			content: transformedDashboardData,
			source: 'local',
			isChunked: true,
			chunkCount: totalChunks,
		};

		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			transformedDashboardData
		);
		dashboard.files.push(fileData);
		await dashboard.save();

		// Clean up in-memory chunks
		chunkStore.delete(chunkId);

		res
			.status(201)
			.json({ message: 'Chunked file processed successfully', dashboard });
	} catch (error) {
		console.error('Error in finalizeChunk:', error);
		if (error.message.includes('Bad compressed size')) {
			res.status(400).json({ error: 'Invalid or corrupted Excel/CSV file' });
		} else {
			res.status(500).json({ error: error.message });
		}
	} finally {
		// Ensure cleanup in case of errors
		if (chunkStore.has(req.body.chunkId)) {
			chunkStore.delete(req.body.chunkId);
		}
	}
};

/**
 * POST /users/:id/dashboard/:dashboardId/cloudText
 * Processes raw cloud text (e.g., from Google Drive) using GPT, merges the data into the dashboard,
 * and updates the dashboard in the database.
 */
export const processCloudText = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.params;
		const { fullText, fileName } = req.body;

		if (!fullText)
			return res.status(400).json({ message: 'No fullText provided' });
		if (!fileName)
			return res.status(400).json({ message: 'No fileName provided' });
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboardId' });
		}

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		let cleanedText = removeEmptyOrCommaLines(fullText);
		cleanedText = removeExcessiveRepetitions(cleanedText, 3);

		const TEMPLATE = `
You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript.
Output only valid JavaScript code with proper JSON syntax:
- Use double quotes for strings.
- Do not include trailing commas.
- Do not include comments or extra text.
- Preserve ISO date strings (e.g., "2024-03-01T23:00:00.000Z") exactly as provided without modification.

Given the following text:
{document_text}

Transform it into table data as:
const data = [{...}, {...}];
`.trim();

		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({ document_text: cleanedText });

		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
			maxTokens: 4096,
		});
		const gptResponse = await model.predict(formattedPrompt);

		const extractedData = extractJavascriptCode(gptResponse);
		const { dashboardData } = transformDataStructure(extractedData, fileName);

		if (!dashboardData) {
			return res.status(400).json({ message: 'dashboardData is required' });
		}

		dashboard.files = dashboard.files.filter((f) => f.filename !== fileName);
		dashboard.dashboardData.forEach((category) => {
			category.mainData.forEach((chart) => {
				chart.data = chart.data.filter((entry) => entry.fileName !== fileName);
			});
			category.mainData = category.mainData.filter(
				(chart) => chart.data.length > 0
			);
		});
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(category) => category.mainData.length > 0
		);

		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);

		const fileData = {
			fileId: 'cloud-' + Date.now(),
			filename: fileName,
			content: dashboardData,
			lastUpdate: new Date(),
		};
		dashboard.files.push(fileData);

		await dashboard.save();

		const io = req.app.get('io');
		io.to(dashboardId).emit('dashboard-updated', { dashboardId, dashboard });

		res.status(201).json({
			message: 'Cloud text processed and data stored successfully',
			dashboard,
		});
	} catch (error) {
		console.error('Error processing cloud text:', error);
		return res
			.status(500)
			.json({ message: 'Server error', error: error.message });
	}
};

/**
 * POST /users/:id/dashboard/uploadCloud
 * Uploads pre-processed cloud data to update or create a dashboard.
 */
export const uploadCloudData = async (req, res) => {
	try {
		const userId = req.params.id;
		const {
			dashboardId,
			dashboardName,
			fileName,
			dashboardData,
			folderId,
			channelExpiration,
		} = req.body;
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).json({
				message:
					'fileId is required. Please provide a valid Google Drive fileId.',
			});
		}
		if (
			!fileName ||
			!Array.isArray(dashboardData) ||
			dashboardData.length === 0
		) {
			return res.status(400).json({
				message: 'fileName and a non-empty dashboardData are required',
			});
		}

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.json({ message: 'No valid tokens found for user' });
		}
		const authClient = await getUserAuthClient(
			tokens.access_token,
			tokens.refresh_token,
			tokens.expiry_date
		);
		if (!authClient) {
			return res
				.status(401)
				.json({ message: 'Could not create an authenticated client' });
		}

		let lastUpdate = new Date();
		try {
			const modifiedTimeStr = await getGoogleDriveModifiedTime(
				fileId,
				authClient
			);
			if (modifiedTimeStr) lastUpdate = new Date(modifiedTimeStr);
		} catch (err) {
			console.warn(
				'Failed to fetch modifiedTime from Drive. Using current date.',
				err.message
			);
		}

		let expireDate = channelExpiration
			? new Date(channelExpiration)
			: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		if (isNaN(expireDate.getTime())) {
			expireDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		}

		let dashboard;
		if (dashboardId) {
			if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
				return res.status(400).json({ message: 'Invalid dashboardId' });
			}
			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				return res
					.status(404)
					.json({ message: `Dashboard ID ${dashboardId} not found` });
			}
		} else {
			const existing = await Dashboard.findOne({ dashboardName, userId });
			if (existing) {
				return res.status(400).json({
					message: `Dashboard name "${dashboardName}" already exists`,
				});
			}
			dashboard = new Dashboard({
				dashboardName,
				userId,
				dashboardData: [],
				files: [],
			});
		}

		dashboard.files = dashboard.files.filter((f) => f.filename !== fileName);
		dashboard.dashboardData.forEach((category) => {
			category.mainData.forEach((chart) => {
				chart.data = chart.data.filter((entry) => entry.fileName !== fileName);
			});
			category.mainData = category.mainData.filter(
				(chart) => chart.data.length > 0
			);
		});
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(category) => category.mainData.length > 0
		);
		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);
		dashboard.files.push({
			fileId,
			filename: fileName,
			content: dashboardData,
			lastUpdate,
			source: 'google',
			monitoring: { status: 'active', expireDate, folderId: folderId || null },
		});

		let attempts = 0;
		while (attempts < 5) {
			const mergedFileNames = new Set();
			dashboard.dashboardData.forEach((category) => {
				category.mainData.forEach((chart) => {
					chart.data.forEach((entry) => mergedFileNames.add(entry.fileName));
				});
			});
			if (mergedFileNames.size === dashboard.files.length) break;
			dashboard.files.forEach((fileRecord) => {
				if (!mergedFileNames.has(fileRecord.filename)) {
					dashboard.dashboardData = mergeDashboardData(
						dashboard.dashboardData,
						fileRecord.content
					);
				}
			});
			attempts++;
		}

		await dashboard.save();
		res
			.status(200)
			.json({ message: 'Cloud data uploaded successfully', dashboard });
	} catch (error) {
		console.error('uploadCloudData error:', error);
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * GET /users/:id/dashboard/:dashboardId/check-monitored-files
 * Checks monitored files for updates since last login and pulls new data if modified.
 */
export const checkAndUpdateMonitoredFiles = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboardId' });
		}

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.json({ message: 'No valid tokens found for user' });
		}
		const authClient = await getUserAuthClient(
			tokens.access_token,
			tokens.refresh_token,
			tokens.expiry_date
		);
		const drive = google.drive({ version: 'v3', auth: authClient });

		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		const updatedFiles = [];
		for (const file of dashboard.files.filter(
			(f) => f.source === 'google' && f.monitoring.status === 'active'
		)) {
			const { fileId, filename, lastUpdate } = file;
			if (!fileId || fileId === filename) continue;

			try {
				const currentModifiedTime = await drive.files
					.get({
						fileId,
						fields: 'modifiedTime',
					})
					.then((res) => res.data.modifiedTime);
				const storedDate = new Date(lastUpdate);
				const currentDate = new Date(currentModifiedTime);

				if (currentDate > storedDate) {
					const fileContent = await fetchFileContent(fileId, authClient);
					const dashboardData = await processFileContent(fileContent, filename);
					dashboard.files = dashboard.files.filter(
						(f) => f.filename !== filename
					);
					dashboard.dashboardData.forEach((category) => {
						category.mainData.forEach((chart) => {
							chart.data = chart.data.filter(
								(entry) => entry.fileName !== filename
							);
						});
						category.mainData = category.mainData.filter(
							(chart) => chart.data.length > 0
						);
					});
					dashboard.dashboardData = dashboard.dashboardData.filter(
						(category) => category.mainData.length > 0
					);
					dashboard.dashboardData = mergeDashboardData(
						dashboard.dashboardData,
						dashboardData
					);
					dashboard.files.push({
						fileId,
						filename,
						content: dashboardData,
						lastUpdate: currentDate,
						source: 'google',
						monitoring: file.monitoring,
					});
					updatedFiles.push({
						fileId,
						filename,
						lastUpdate: currentModifiedTime,
					});
				}
			} catch (err) {
				console.warn(`Error checking file ${fileId}:`, err.message);
			}
		}

		if (updatedFiles.length > 0) {
			await dashboard.save();
			const io = req.app.get('io');
			io.to(dashboardId).emit('dashboard-updated', { dashboardId, dashboard });
		}

		res.status(200).json({
			message:
				updatedFiles.length > 0
					? 'Updated monitored files'
					: 'No updates detected',
			updatedFiles,
		});
	} catch (error) {
		console.error('Error checking monitored files:', error);
		res.status(500).json({ message: 'Server error', error: error.message });
	}
};

/**
 * Helper: Fetches file content from Google Drive.
 */
async function fetchFileContent(fileId, authClient) {
	const drive = google.drive({ version: 'v3', auth: authClient });
	const meta = await drive.files.get({ fileId, fields: 'mimeType' });
	const mimeType = meta.data.mimeType;
	let fileContent = '';

	if (mimeType === 'application/vnd.google-apps.document') {
		const docs = google.docs({ version: 'v1', auth: authClient });
		const docResp = await docs.documents.get({ documentId: fileId });
		fileContent = extractPlainText(docResp.data);
	} else if (
		mimeType === 'text/csv' ||
		mimeType === 'application/vnd.google-apps.spreadsheet'
	) {
		const csvResp = await drive.files.export(
			{ fileId, mimeType: 'text/csv' },
			{ responseType: 'arraybuffer' }
		);
		fileContent = Buffer.from(csvResp.data).toString('utf8');
	} else if (
		mimeType ===
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
	) {
		const xlsxResp = await drive.files.get(
			{ fileId, alt: 'media' },
			{ responseType: 'arraybuffer' }
		);
		const workbook = xlsx.read(new Uint8Array(xlsxResp.data), {
			type: 'array',
		});
		fileContent = workbook.SheetNames.map((sheetName) =>
			xlsx.utils.sheet_to_csv(workbook.Sheets[sheetName])
		).join('\n\n');
	} else {
		console.warn(`Unsupported mimeType: ${mimeType} for file ${fileId}`);
	}
	return fileContent;
}

/**
 * Helper: Processes file content into dashboardData using GPT.
 */
async function processFileContent(fullText, fileName) {
	try {
		const data = JSON.parse(fullText);
		if (!Array.isArray(data)) {
			throw new Error('Parsed data is not an array');
		}
		const { dashboardData } = transformDataStructure(data, fileName);
		return dashboardData;
	} catch (error) {
		console.error('Error processing file content:', error);
		throw error;
	}
}

/**
 * Helper: Extracts plain text from a Google Doc.
 */
function extractPlainText(doc) {
	if (!doc.body || !doc.body.content) return '';
	let text = '';
	for (const element of doc.body.content) {
		if (element.paragraph?.elements) {
			for (const pe of element.paragraph.elements) {
				if (pe.textRun?.content) text += pe.textRun.content;
			}
			text += '\n';
		}
	}
	return text.trim();
}

/**
 * POST /users/:id/dashboard/upload
 * Creates or updates a dashboard with uploaded file data.
 */
export const createOrUpdateDashboard = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId, dashboardName } = req.body;

		if (!req.file) {
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const file = req.file;
		const fileType = file.mimetype;
		const fileName = file.originalname;

		// Validate file type
		const allowedTypes = [
			'application/pdf',
			'image/png',
			'image/jpeg',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'text/csv',
		];
		if (!allowedTypes.includes(fileType)) {
			return res.status(400).json({
				message: 'Unsupported file type',
				receivedType: fileType,
				allowedTypes,
			});
		}

		// Extract text
		let documentText;
		if (
			fileType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			fileType === 'application/vnd.ms-excel' ||
			fileType === 'text/csv'
		) {
			const workbook = xlsx.read(file.buffer, {
				type: 'buffer',
				cellDates: true,
			});
			if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
				return res.status(400).json({ error: 'Excel/CSV file has no sheets' });
			}
			const sheet = workbook.Sheets[workbook.SheetNames[0]];
			if (!sheet) {
				return res
					.status(400)
					.json({ error: 'Invalid sheet in Excel/CSV file' });
			}
			const data = xlsx.utils.sheet_to_json(sheet);
			if (!data || !Array.isArray(data)) {
				return res
					.status(400)
					.json({ error: 'No valid data extracted from Excel/CSV file' });
			}
			console.log('Excel/CSV processing details:', {
				fileName,
				sheetNames: workbook.SheetNames,
				dataLength: data.length,
			});
			documentText = JSON.stringify(data);
		} else if (fileType === 'application/pdf') {
			const pdfReader = new PdfReader();
			documentText = await new Promise((resolve, reject) => {
				let text = '';
				pdfReader.parseBuffer(file.buffer, (err, item) => {
					if (err) reject(err);
					else if (!item) resolve(text);
					else if (item.text) text += item.text + ' ';
				});
			});
		} else if (fileType === 'image/png' || fileType === 'image/jpeg') {
			const image = sharp(file.buffer);
			const buffer = await image.toBuffer();
			const result = await tesseract.recognize(buffer);
			documentText = result.data.text;
		} else {
			throw new Error('Unexpected file type after validation');
		}

		console.log('Extracted document text length:', documentText.length);

		// Transform data
		let response;
		try {
			response = transformExcelDataToJSCode(documentText);
			console.log('AI transformation response length:', response.length);
		} catch (transformError) {
			console.error('Error transforming data:', transformError);
			return res.status(500).json({
				error: `Data transformation failed: ${transformError.message}`,
			});
		}

		const extractedData = extractJavascriptCode(response);
		console.log('Extracted data items:', extractedData.length);

		const formedData = transformDataStructure(extractedData, fileName);
		const { dashboardData } = formedData;

		if (!dashboardData || dashboardData.length === 0) {
			return res
				.status(400)
				.json({ message: 'No valid dashboard data extracted' });
		}

		// Save to database
		const fileData = {
			filename: fileName,
			content: dashboardData,
		};

		let dashboard;
		if (dashboardId) {
			if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
				return res.status(400).json({ message: 'Invalid dashboard ID' });
			}

			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				return res
					.status(404)
					.json({ message: `Dashboard ID ${dashboardId} not found` });
			}
			dashboard.dashboardData = mergeDashboardData(
				dashboard.dashboardData,
				dashboardData
			);
			dashboard.files.push(fileData);
		} else if (dashboardName) {
			const existingDashboard = await Dashboard.findOne({
				dashboardName,
				userId,
			});
			if (existingDashboard) {
				return res
					.status(400)
					.json({ message: 'Dashboard name already exists' });
			}
			dashboard = new Dashboard({
				dashboardName,
				dashboardData,
				files: [fileData],
				userId,
			});
		} else {
			return res
				.status(400)
				.json({ message: 'dashboardId or dashboardName is required' });
		}

		await dashboard.save();

		res
			.status(201)
			.json({ message: 'Dashboard processed successfully', dashboard });
	} catch (error) {
		console.error('Error in createOrUpdateDashboard:', {
			message: error.message,
			stack: error.stack,
			fileName: req.file?.originalname,
			fileType: req.file?.mimetype,
		});
		res.status(500).json({ error: error.message });
	}
};

function removeEmptyOrCommaLines(text) {
	return text
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed !== '' && trimmed !== ',';
		})
		.join('\n');
}

function removeExcessiveRepetitions(text, MAX_REPEAT_COUNT = 3) {
	const lines = text.split('\n');
	const cleanedLines = [];
	let lastLine = null;
	let repeatCount = 0;
	for (const line of lines) {
		if (line === lastLine) {
			repeatCount++;
			if (repeatCount <= MAX_REPEAT_COUNT) {
				cleanedLines.push(line);
			}
		} else {
			lastLine = line;
			repeatCount = 1;
			cleanedLines.push(line);
		}
	}
	return cleanedLines.join('\n');
}
