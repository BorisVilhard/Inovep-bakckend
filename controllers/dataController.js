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
import { getGoogleDriveModifiedTime } from '../utils/googleDriveService.js';
import { getUserAuthClient } from '../utils/oauthService.js';

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

// Verify User Ownership Middleware
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user.id;
	const userIdFromParams = req.params.id;

	if (userIdFromToken !== userIdFromParams) {
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
};

// Get all dashboards for a user
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

// Get a specific dashboard for a user
export const getDashboardById = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await Dashboard.findOne({
			_id: dashboardId,
			userId,
		});
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

// Create a new dashboard
export const createDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardName } = req.body;

	if (!dashboardName) {
		return res.status(400).json({ message: 'dashboardName is required' });
	}

	try {
		// Check if dashboardName is unique for the user
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

// Update an existing dashboard
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

		// If updating dashboardName, ensure it's unique
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

		// Update dashboardData if provided
		if (dashboardData) {
			dashboard.dashboardData = dashboardData;
		}

		await dashboard.save();
		res.json({ message: 'Dashboard updated successfully', dashboard });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete a dashboard
export const deleteDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;

	// Validate dashboardId
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

// Delete data associated with a specific fileName from a dashboard
export const deleteDataByFileName = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, fileName } = req.params;

	// Validate dashboardId
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

		// Remove the file from the files array
		dashboard.files = dashboard.files.filter(
			(file) => file.filename !== fileName
		);

		// Remove data from dashboardData associated with this file
		dashboard.dashboardData.forEach((category) => {
			category.mainData = category.mainData.filter((chart) => {
				// Remove data points from chart.data that have matching fileName
				chart.data = chart.data.filter(
					(dataPoint) => dataPoint.fileName !== fileName
				);
				// Remove chart if no data points left
				return chart.data.length > 0;
			});
		});

		// Remove categories that have no mainData left
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

// Get all files associated with a dashboard
export const getDashboardFiles = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		const dashboard = await Dashboard.findOne({
			_id: dashboardId,
			userId,
		});
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

// Function to extract text from different document types
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
					// End of file
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

// Function to extract JavaScript code from AI response
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

// Function to clean numeric values in strings
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

function transformDataStructure(data, fileName) {
	const dashboardData = [];
	const today = format(new Date(), 'yyyy-MM-dd');

	data.forEach((item) => {
		const groupNameKey = Object.keys(item)[0];
		let monthName = item[groupNameKey];
		delete item[groupNameKey];

		// Convert monthName to string if it's not
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
				// Ensure key is a string
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

// controllers/dataController.js

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

		if (combinedData) {
			category.combinedData = combinedData;
		}

		if (summaryData) {
			category.summaryData = summaryData;
		}

		if (appliedChartType) {
			category.appliedChartType = appliedChartType;
		}

		if (checkedIds) {
			category.checkedIds = checkedIds;
		}

		await dashboard.save();

		res.json({ message: 'Category data updated successfully', dashboard });
	} catch (error) {
		console.error('Error updating category data:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

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
		// Find the dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		// Find the specific category
		const category = dashboard.dashboardData.id(categoryId);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		// Validate that chartIds exist in mainData
		const validChartIds = category.mainData.map((chart) => chart.id);
		const isValid = chartIds.every((id) => validChartIds.includes(id));
		if (!isValid) {
			return res
				.status(400)
				.json({ message: 'One or more chartIds are invalid' });
		}

		// Aggregate data from the selected chartIds
		let aggregatedEntries = [];
		category.mainData.forEach((chart) => {
			if (chartIds.includes(chart.id)) {
				aggregatedEntries = [...aggregatedEntries, ...chart.data];
			}
		});

		const combinedChartId = `combined-${Date.now()}`;

		// Create CombinedChart object
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

export const deleteCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;

	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		const category = dashboard.dashboardData.id(categoryId);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		const combinedChart = category.combinedData.id(combinedChartId);
		if (!combinedChart) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}

		combinedChart.remove();

		await dashboard.save();

		res.status(200).json({ message: 'CombinedChart deleted successfully' });
	} catch (error) {
		console.error('Error deleting CombinedChart:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

// controllers/dataController.js

// Update CombinedChart in a DashboardCategory
export const updateCombinedChart = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId, categoryId, combinedChartId } = req.params;
	const { chartType, chartIds } = req.body; // Optional fields to update

	try {
		// Find the dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		// Find the specific category
		const category = dashboard.dashboardData.id(categoryId);
		if (!category) {
			return res.status(404).json({ message: 'Dashboard category not found' });
		}

		// Find the CombinedChart
		const combinedChart = category.combinedData.id(combinedChartId);
		if (!combinedChart) {
			return res.status(404).json({ message: 'CombinedChart not found' });
		}

		// Update chartType if provided
		if (chartType) {
			if (!validChartTypes.includes(chartType)) {
				return res.status(400).json({ message: 'Invalid chartType' });
			}
			combinedChart.chartType = chartType;
		}

		// Update chartIds if provided
		if (chartIds) {
			if (!Array.isArray(chartIds) || chartIds.length < 2) {
				return res
					.status(400)
					.json({ message: 'At least two chartIds are required' });
			}

			// Validate that new chartIds exist in mainData
			const validChartIds = category.mainData.map((chart) => chart.id);
			const isValid = chartIds.every((id) => validChartIds.includes(id));
			if (!isValid) {
				return res
					.status(400)
					.json({ message: 'One or more chartIds are invalid' });
			}

			// Update chartIds
			combinedChart.chartIds = chartIds;

			// Re-aggregate data based on new chartIds
			let aggregatedEntries = [];
			category.mainData.forEach((chart) => {
				if (chartIds.includes(chart.id)) {
					aggregatedEntries = [...aggregatedEntries, ...chart.data];
				}
			});
			combinedChart.data = aggregatedEntries;
		}

		// Save the dashboard
		await dashboard.save();

		res
			.status(200)
			.json({ message: 'CombinedChart updated successfully', combinedChart });
	} catch (error) {
		console.error('Error updating CombinedChart:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

// controllers/dataController.js

// Create or Update a Dashboard with CombinedChart Support
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

		// Validate file type
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

		// Extract text from the uploaded document
		const documentText = await getDocumentText(filePath, fileType);

		// Set up the prompt template
		const TEMPLATE = `You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript don't add additional text or code.

Given the following text:
{document_text}

Transform it into table data in one array of objects called 'data' in JavaScript. Provide only the JavaScript code, and ensure the code is valid JavaScript.`;

		// Initialize the prompt with the extracted document text
		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({
			document_text: documentText,
		});

		// Initialize the ChatOpenAI model
		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
		});

		// Get the AI's response
		const response = await model.predict(formattedPrompt);
		const aiResponseContent = response;

		// Extract the JavaScript code containing the data array from the response
		const extractedData = extractJavascriptCode(aiResponseContent);
		const formedData = transformDataStructure(extractedData, fileName);

		// Extract dashboardData from formedData
		const { dashboardData } = formedData;

		if (!dashboardData) {
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res.status(400).json({ message: 'dashboardData is required' });
		}

		// Now store the file content into the files array
		const fileData = {
			filename: fileName,
			content: dashboardData, // Store the processed data
		};

		let dashboard;
		if (dashboardId) {
			// Find existing dashboard
			dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
			if (!dashboard) {
				fs.unlink(filePath, (err) => {
					if (err) console.error('Error deleting file:', err);
				});
				return res
					.status(404)
					.json({ message: `Dashboard ID ${dashboardId} not found` });
			}

			// Merge new data into existing dashboard
			dashboard.dashboardData = mergeDashboardData(
				dashboard.dashboardData,
				dashboardData
			);

			// Add the file to the files array
			dashboard.files.push(fileData);
		} else if (dashboardName) {
			// Create a new dashboard
			// Check if dashboardName is unique
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
			// No dashboardId or dashboardName provided
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res
				.status(400)
				.json({ message: 'dashboardId or dashboardName is required' });
		}

		await dashboard.save();

		// Clean up uploaded file
		fs.unlink(filePath, (err) => {
			if (err) console.error('Error deleting file:', err);
		});

		res.status(201).json({
			message: 'Dashboard processed successfully',
			dashboard,
		});
	} catch (error) {
		console.error('Error processing document and creating dashboard:', error);

		// Clean up uploaded file in case of error
		if (req.file) {
			const filePath = path.join(UPLOAD_FOLDER, req.file.filename);
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
		}

		res.status(500).json({ error: error.message });
	}
};

// controllers/dataController.js

export const processFile = async (req, res) => {
	try {
		const userId = req.params.id;
		if (!req.file) {
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const file = req.file;
		const filePath = path.join(UPLOAD_FOLDER, file.filename);
		const fileType = file.mimetype;
		const fileName = file.originalname;

		// Validate file type
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

		// Extract text from the uploaded document
		const documentText = await getDocumentText(filePath, fileType);

		// Set up the prompt template
		const TEMPLATE = `You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript don't add additional text or code.

Given the following text:
{document_text}

Transform it into table data in one array of objects called 'data' in JavaScript. Provide only the JavaScript code, and ensure the code is valid JavaScript.`;

		// Initialize the prompt with the extracted document text
		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({
			document_text: documentText,
		});

		// Initialize the ChatOpenAI model
		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
		});

		// Get the AI's response
		const response = await model.predict(formattedPrompt);
		const aiResponseContent = response;

		// Extract the JavaScript code containing the data array from the response
		const extractedData = extractJavascriptCode(aiResponseContent);
		const formedData = transformDataStructure(extractedData, fileName);

		// Extract dashboardData from formedData
		const { dashboardData } = formedData;

		if (!dashboardData) {
			fs.unlink(filePath, (err) => {
				if (err) console.error('Error deleting file:', err);
			});
			return res.status(400).json({ message: 'dashboardData is required' });
		}

		// Clean up uploaded file
		fs.unlink(filePath, (err) => {
			if (err) console.error('Error deleting file:', err);
		});

		// Return the dashboardData without updating the dashboard
		res.status(200).json({ dashboardData });
	} catch (error) {
		console.error('Error processing document:', error);

		// Clean up uploaded file in case of error
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
 * Removes lines that are empty or just a comma.
 */
function removeEmptyOrCommaLines(text) {
	return text
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			// Keep only lines that are non-empty AND not just ","
			return trimmed !== '' && trimmed !== ',';
		})
		.join('\n');
}

/**
 * Limits consecutive identical lines to `MAX_REPEAT_COUNT`.
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

export const processCloudText = async (req, res) => {
	try {
		// 1. Destructure params and body
		const userId = req.params.id;
		const { dashboardId } = req.params;
		const { fullText, fileName } = req.body;

		// 2. Validate input
		if (!fullText) {
			return res.status(400).json({ message: 'No fullText provided' });
		}
		if (!fileName) {
			return res.status(400).json({ message: 'No fileName provided' });
		}
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboardId' });
		}

		// 3. Fetch the user’s dashboard
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res.status(404).json({ message: 'Dashboard not found' });
		}

		// 4. Clean the incoming text (optional but often helpful)
		let cleanedText = removeEmptyOrCommaLines(fullText);
		cleanedText = removeExcessiveRepetitions(cleanedText, 3);

		// 5. Build your GPT prompt (optional).
		//    If you want to transform text using GPT, do so here. Example:
		const TEMPLATE = `
You are a helpful assistant that transforms the given data into table data in one array of objects called 'data' in JavaScript.
Don't add additional text or code.

Given the following text:
{document_text}

Transform it into table data in one array of objects called 'data' in JavaScript.
Provide only the JavaScript code, and ensure the code is valid JavaScript.
    `.trim();

		// 5a. Prepare the prompt
		const prompt = PromptTemplate.fromTemplate(TEMPLATE);
		const formattedPrompt = await prompt.format({ document_text: cleanedText });

		// 5b. Call GPT (assuming you have an OpenAI API key in your .env)
		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-3.5-turbo',
			temperature: 0.8,
		});
		const gptResponse = await model.predict(formattedPrompt);

		// 6. Extract the JavaScript array from GPT’s response
		const extractedData = extractJavascriptCode(gptResponse);
		// => e.g. [ { Month: "Jan", Sales: 100 }, ... ]

		// 7. Convert the array into your dashboard shape
		const formedData = transformDataStructure(extractedData, fileName);
		const { dashboardData: newDashboardData } = formedData;
		if (!newDashboardData) {
			return res
				.status(400)
				.json({ message: 'No valid dashboardData generated' });
		}

		// 8. Merge the new data with the existing Dashboard’s data
		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			newDashboardData
		);

		// 9. Add a new record in the files[] array
		//    (since fileId is required, generate one if you don’t have a real ID from Drive)
		dashboard.files.push({
			fileId: 'cloud-' + Date.now(),
			filename: fileName,
			content: newDashboardData,
			lastUpdate: new Date(), // or any Date you wish
		});

		// 10. Save the updated Dashboard
		await dashboard.save();

		// 11. Return the updated Dashboard
		return res.status(200).json({
			message: 'Cloud text processed and data stored successfully',
			dashboard,
		});
	} catch (error) {
		console.error('Error processing cloud text:', error);
		return res.status(500).json({ error: error.message });
	}
};

export const uploadCloudData = async (req, res) => {
	try {
		// 1. Gather inputs
		const userId = req.params.id; // from /users/:id/...
		const { dashboardId, dashboardName, fileId, fileName, dashboardData } =
			req.body;

		// 2. Validate required fields
		if (!fileId || !fileName || !dashboardData) {
			return res.status(400).json({
				message: 'fileId, fileName, and dashboardData are required',
			});
		}
		if (!dashboardId && !dashboardName) {
			return res
				.status(400)
				.json({ message: 'dashboardId or dashboardName is required' });
		}

		// 3. Get a valid Google OAuth2 client for this user
		//    (Or your service account client if your app uses a single "admin" approach)
		const authClient = await getUserAuthClient(userId);
		if (!authClient) {
			return res
				.status(401)
				.json({ message: 'Could not get authenticated client' });
		}

		// 4. Fetch the Drive file’s lastUpdate (modifiedTime)
		const modifiedTimeStr = await getGoogleDriveModifiedTime(
			fileId,
			authClient
		);
		const lastUpdate = modifiedTimeStr ? new Date(modifiedTimeStr) : undefined;

		// 5. Find or create the Dashboard
		let dashboard;
		if (dashboardId) {
			// If user wants to add/merge data into existing dashboard
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
			// No dashboardId => try creating new by name
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

		// 6. Remove old data for this same fileName/fileId if you want to avoid duplicates
		dashboard.files = dashboard.files.filter((f) => f.fileId !== fileId);
		dashboard.dashboardData.forEach((cat) => {
			cat.mainData.forEach((chart) => {
				chart.data = chart.data.filter((entry) => entry.fileName !== fileName);
			});
			// remove charts with zero data
			cat.mainData = cat.mainData.filter((chart) => chart.data.length > 0);
		});
		// remove categories that have zero mainData
		dashboard.dashboardData = dashboard.dashboardData.filter(
			(cat) => cat.mainData.length > 0
		);

		// 7. Merge new data into existing Dashboard
		dashboard.dashboardData = mergeDashboardData(
			dashboard.dashboardData,
			dashboardData
		);

		// 8. Add a new file record to the `files[]` array

		dashboard.files.push({
			fileId: 'cloud-' + Date.now(), // you can create any unique ID
			filename: fileName,
			content: newDashboardData,
			lastUpdate: new Date(), // if you want a timestamp
		});

		// 9. Save and return
		await dashboard.save();

		return res.status(200).json({
			message: 'Cloud data uploaded successfully',
			dashboard,
		});
	} catch (error) {
		console.error('Error in uploadCloudData:', error);
		return res
			.status(500)
			.json({ message: 'Server error', error: error.message });
	}
};
