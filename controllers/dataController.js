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
import { v4 as uuidv4 } from 'uuid';

const UPLOAD_FOLDER = './uploads';

// Verify User Ownership Middleware
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user.id;
	const userIdFromParams = req.params.id;

	if (userIdFromToken !== userIdFromParams) {
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
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

// Create a new dashboard or merge data into an existing one
export const createOrUpdateDashboard = async (req, res) => {
	try {
		const userId = req.params.id;
		const { dashboardId } = req.body; // Get dashboardId from request body

		if (!req.file) {
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const file = req.file;
		const filePath = path.join(UPLOAD_FOLDER, file.filename);
		const fileType = file.mimetype;
		const fileName = file.originalname; // Extract original file name

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
		const formedData = transformDataStructure(extractedData, fileName); // Pass fileName here
		console.log('data=', JSON.stringify(formedData, null, 4));

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
		} else {
			// Create a new dashboard
			dashboard = new Dashboard({
				dashboardData,
				files: [fileData],
				userId,
			});
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
	const { dashboardData } = req.body;

	if (!dashboardData) {
		return res.status(400).json({ message: 'dashboardData is required' });
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

		// Update the dashboardData
		dashboard.dashboardData = dashboardData;

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
		const monthName = item[groupNameKey];
		delete item[groupNameKey];

		if (monthName) {
			const charts = [];
			for (const [key, value] of Object.entries(item)) {
				const cleanedValue = cleanNumeric(value);
				charts.push({
					chartType: 'Area',
					id: uuidv4(), // Generate a unique ID
					data: [
						{
							title: key,
							value: cleanedValue,
							date: today,
							fileName: fileName, // Include fileName here
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

function mergeDashboardData(existingData, newData) {
	const mergedData = [...existingData];

	newData.forEach((newCategory) => {
		const existingCategoryIndex = mergedData.findIndex(
			(cat) => cat.categoryName === newCategory.categoryName
		);

		if (existingCategoryIndex !== -1) {
			const existingCategory = mergedData[existingCategoryIndex];

			newCategory.mainData.forEach((newChart) => {
				const newChartTitle = newChart.data[0]?.title;

				const existingChartIndex = existingCategory.mainData.findIndex(
					(chart) => chart.data[0]?.title === newChartTitle
				);

				if (existingChartIndex !== -1) {
					const existingChart = existingCategory.mainData[existingChartIndex];
					// Merge data arrays
					existingChart.data = [...existingChart.data, ...newChart.data];
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
