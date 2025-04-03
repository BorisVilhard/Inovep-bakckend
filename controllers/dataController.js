// controllers/dataController.js
import Dashboard from '../model/Data.js';
import mongoose from 'mongoose';
import { PdfReader } from 'pdfreader';
import { format } from 'date-fns';
import sharp from 'sharp';
import tesseract from 'tesseract.js';
import xlsx from 'xlsx';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import fs from 'fs';
import path from 'path';
import { mergeDashboardData } from '../utils/dashboardUtils.js';
import { transformExcelDataToJSCode } from '../utils/ transformExcel.js';
import { getGoogleDriveModifiedTime } from '../utils/googleDriveService.js';
import { getUserAuthClient } from '../utils/oauthService.js';
import { getTokens } from '../tokenStore.js';
import { google } from 'googleapis';

const UPLOAD_FOLDER = './uploads';

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
		res.status(500).json({ message: 'Server error', error });
	}
};

/**
 * Extracts text from a document based on its type.
 */
const getDocumentText = async (filePath, fileType) => {
	let text = '';
	if (fileType === 'application/pdf') {
		const pdfReader = new PdfReader();
		const data = fs.readFileSync(filePath);
		return new Promise((resolve, reject) => {
			pdfReader.parseBuffer(data, (err, item) => {
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
		const image = sharp(filePath);
		const buffer = await image.toBuffer();
		const result = await tesseract.recognize(buffer);
		text = result.data.text;
		return text;
	} else if (
		fileType ===
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		fileType === 'application/vnd.ms-excel'
	) {
		const workbook = xlsx.readFile(filePath);
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = xlsx.utils.sheet_to_json(sheet);
		text = JSON.stringify(data);
		return text;
	} else {
		throw new Error('Unsupported file type');
	}
};

function extractJavascriptCode(response) {
	try {
		const jsCodePattern = /const\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
		const match = response.match(jsCodePattern);
		if (match) {
			let jsArrayString = match[1];
			jsArrayString = jsArrayString.replace(/\/\/.*/g, '');
			jsArrayString = jsArrayString.replace(/(\w+):/g, '"$1":');
			jsArrayString = jsArrayString.replace(/'/g, '"');
			jsArrayString = jsArrayString.replace(/\b(null|undefined)\b/g, 'null');
			jsArrayString = jsArrayString.replace(/,\s*\]/g, ']');
			return JSON.parse(jsArrayString);
		} else {
			return [];
		}
	} catch (error) {
		console.error('Error decoding JSON:', error);
		return [];
	}
}

/**
 * Cleans a string value by extracting numeric content.
 */
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

/**
 * Transforms the extracted data into the dashboard data structure.
 */
function transformDataStructure(data, fileName) {
	const dashboardData = [];
	const today = format(new Date(), 'yyyy-MM-dd');
	data.forEach((item) => {
		const groupNameKey = Object.keys(item)[0];
		let monthName = item[groupNameKey];
		delete item[groupNameKey];
		if (typeof monthName !== 'string') {
			console.warn(
				'monthName is not a string. Converting to string.',
				monthName
			);
			monthName = String(monthName);
		}
		if (monthName) {
			const charts = [];
			for (const [key, value] of Object.entries(item)) {
				let chartTitle = key;
				if (typeof chartTitle !== 'string') {
					console.warn(
						'chartTitle is not a string. Converting to string.',
						chartTitle
					);
					chartTitle = String(chartTitle);
				}
				const cleanedValue = cleanNumeric(value);
				const chartId = generateChartId(monthName, chartTitle);
				charts.push({
					chartType: 'Area',
					id: chartId,
					data: [
						{
							title: chartTitle,
							value: cleanedValue,
							date: today,
							fileName: fileName,
						},
					],
					isChartTypeChanged: false,
					fileName: fileName,
				});
			}
			dashboardData.push({
				categoryName: monthName,
				mainData: charts,
				combinedData: [],
			});
		}
	});
	return { dashboardData };
}

/**
 * PUT /users/:id/dashboard/:dashboardId/chart/:chartId
 * Updates the chart type for a specific chart.
 */
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

export const createOrUpdateDashboard = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId, dashboardName } = req.body;
		if (!req.file) {
			return res.status(400).json({ message: 'No file uploaded' });
		}
		const file = req.file;
		const filePath = path.join(UPLOAD_FOLDER, file.filename);
		const fileType = file.mimetype;
		const fileName = file.originalname;
		const allowedTypes = [
			'application/pdf',
			'image/png',
			'image/jpeg',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
		];
		if (!allowedTypes.includes(fileType)) {
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res.status(400).json({ message: 'Unsupported file type' });
		}
		const documentText = await getDocumentText(filePath, fileType);
		console.log('document text:', documentText);

		const response = transformExcelDataToJSCode(documentText);
		console.log('ai response', response);
		const extractedData = extractJavascriptCode(response);
		const formedData = transformDataStructure(extractedData, fileName);
		const { dashboardData } = formedData;
		if (!dashboardData) {
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res.status(400).json({ message: 'dashboardData is required' });
		}
		const fileData = { filename: fileName, content: dashboardData };
		let dashboard;
		if (dashboardId) {
			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				fs.unlink(filePath, (err) => {
					if (err) console.error('Error deleting file:', err);
				});
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
				fs.unlink(filePath, (err) => {
					if (err) console.error('Error deleting file:', err);
				});
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
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res
				.status(400)
				.json({ message: 'dashboardId or dashboardName is required' });
		}
		await dashboard.save();
		fs.unlink(filePath, (err) => {
			if (err) console.error('Error deleting file:', err);
		});
		res
			.status(201)
			.json({ message: 'Dashboard processed successfully', dashboard });
	} catch (error) {
		console.error('Error processing document and creating dashboard:', error);
		if (req.file) {
			const filePath = path.join(UPLOAD_FOLDER, req.file.filename);
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
		}
		res.status(500).json({ error: error.message });
	}
};

/**
 * Utility: Removes lines that are empty or just a comma.
 */
function removeEmptyOrCommaLines(text) {
	return text
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			return trimmed !== '' && trimmed !== ',';
		})
		.join('\n');
}

/**
 * Utility: Limits consecutive identical lines.
 */
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

/**
 * Processes raw cloud text (e.g., from Google Drive) using GPT, merges the data into the dashboard,
 * and updates the dashboard in the database.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const processCloudText = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.params;
		const { fullText, fileName } = req.body;

		// Validate input
		if (!fullText)
			return res.status(400).json({ message: 'No fullText provided' });
		if (!fileName)
			return res.status(400).json({ message: 'No fileName provided' });
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboardId' });
		}

		// Retrieve the dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		// Clean the text
		let cleanedText = removeEmptyOrCommaLines(fullText);
		cleanedText = removeExcessiveRepetitions(cleanedText, 3);

		// Prepare GPT prompt
		const TEMPLATE = `
You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript.
Don't add additional text or code.

Given the following text:
{document_text}

Transform it into table data in one array of objects called 'data' in JavaScript.
Provide only the JavaScript code, and ensure the code is valid JavaScript.
    `.trim();

		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({ document_text: cleanedText });

		// Initialize and call GPT model
		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
		});
		const gptResponse = await model.predict(formattedPrompt);

		// Extract and transform data
		const extractedData = extractJavascriptCode(gptResponse);
		const { dashboardData } = transformDataStructure(extractedData, fileName);

		if (!dashboardData) {
			return res.status(400).json({ message: 'dashboardData is required' });
		}

		// Remove old data associated with this file
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

		// Merge new data
		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);

		// Add new file record
		const fileData = {
			fileId: 'cloud-' + Date.now(),
			filename: fileName,
			content: dashboardData,
			lastUpdate: new Date(),
		};
		dashboard.files.push(fileData);

		// Save the updated dashboard
		await dashboard.save();

		// Emit dashboard-updated event via Socket.io
		const io = req.app.get('io');
		io.to(dashboardId).emit('dashboard-updated', { dashboardId, dashboard });

		// Respond with success
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
		// Require a proper fileId instead of defaulting to fileName.
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

		// Retrieve tokens and create an authenticated client.
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

		// Calculate lastUpdate based on Drive's modifiedTime
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

		// Remove any old data from the same file.
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
		// Merge the new dashboardData.
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
			if (!fileId || fileId === filename) continue; // Skip if fileId isn't a Drive ID

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
		// Parse the JSON string into an array of objects
		const data = JSON.parse(fullText);

		// Validate that the parsed data is an array
		if (!Array.isArray(data)) {
			throw new Error('Parsed data is not an array');
		}

		// Transform the parsed data into the dashboardData structure
		const { dashboardData } = transformDataStructure(data, fileName);

		// Return the transformed dashboardData
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
