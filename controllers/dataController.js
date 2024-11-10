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

// Upload a file and update or create a dashboard
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

// Merge new dashboard data into existing dashboard data
function mergeDashboardData(existingData, newData) {
	const mergedData = [...existingData];

	newData.forEach((newCategory) => {
		const existingCategory = mergedData.find(
			(cat) => cat.categoryName === newCategory.categoryName
		);

		if (existingCategory) {
			newCategory.mainData.forEach((newChart) => {
				const newChartId = newChart.id;

				if (!newChartId) {
					console.error('New chart is missing an id.');
					return;
				}

				const existingChart = existingCategory.mainData.find(
					(chart) => chart.id === newChartId
				);

				if (existingChart) {
					// Check the type of value in newChart.data[0].value
					const newValue = newChart.data[0]?.value;
					if (typeof newValue === 'string') {
						// Replace existing data with new data
						existingChart.data = newChart.data;
					} else {
						// Merge data arrays
						existingChart.data = [...existingChart.data, ...newChart.data];
					}
				} else {
					existingCategory.mainData.push(newChart);
				}
			});
		} else {
			mergedData.push(newCategory);
		}
	});

	return mergedData;
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
