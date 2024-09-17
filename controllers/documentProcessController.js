// documentProcessController.js

import { PdfReader } from 'pdfreader';
import { format } from 'date-fns';
import sharp from 'sharp'; // For image processing
import tesseract from 'tesseract.js'; // For OCR
import openpyxl from 'xlsx';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import fs from 'fs';
import path from 'path';

const UPLOAD_FOLDER = './uploads';

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
		// Load image with sharp and then use tesseract.js for OCR
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
		const workbook = openpyxl.readFile(filePath);
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const data = openpyxl.utils.sheet_to_json(sheet);
		text = JSON.stringify(data);
		return text;
	} else {
		throw new Error('Unsupported file type');
	}
};
function extractJavascriptCode(response) {
	try {
		// Regex pattern to match JavaScript array declarations
		const jsCodePattern = /const\s+\w+\s*=\s*\[.*?\];/s;
		const match = response.match(jsCodePattern);

		if (match) {
			let jsArrayString = match[0];
			// Remove any comments from the JavaScript code
			jsArrayString = jsArrayString.replace(/\/\/.*/g, '');
			// Extract the array portion from the JavaScript declaration
			let jsonLikeString = jsArrayString.substring(
				jsArrayString.indexOf('['),
				jsArrayString.lastIndexOf(']') + 1
			);
			// Convert JavaScript object notation to JSON format
			jsonLikeString = jsonLikeString.replace(/(\w+):/g, '"$1":');
			jsonLikeString = jsonLikeString.replace(/'/g, '"');
			// Handle JavaScript null and undefined values
			jsonLikeString = jsonLikeString.replace(/\b(null|undefined)\b/g, 'null');
			// Remove trailing commas before array closures
			jsonLikeString = jsonLikeString.replace(/,\s*\]/g, ']');
			// Parse the cleaned string into JSON
			return JSON.parse(jsonLikeString);
		} else {
			return [];
		}
	} catch (error) {
		console.error('Error decoding JSON:', error);
		return [];
	}
}

// Function to clean numeric values in strings and convert to appropriate data type
function cleanNumeric(value) {
	if (typeof value === 'string') {
		// Search for numeric patterns including optional negative signs and decimals
		const numMatch = value.match(/-?\d+(\.\d+)?/);
		if (numMatch) {
			const numStr = numMatch[0];
			// Convert to float if it contains a decimal point, otherwise to int
			return numStr.includes('.') ? parseFloat(numStr) : parseInt(numStr, 10);
		}
	}
	return value;
}

// Function to transform data structure
function transformDataStructure(data) {
	const result = [];
	const today = format(new Date(), 'yyyy-MM-dd');
	let idCounter = 1; // Initialize ID counter

	data.forEach((item) => {
		// Dynamically identify the group name key, assuming it is the first key in the item.
		const groupNameKey = Object.keys(item)[0];
		const name = item[groupNameKey];
		delete item[groupNameKey];

		if (name) {
			const pokemonData = [];
			for (const [key, value] of Object.entries(item)) {
				const cleanedValue = cleanNumeric(value);
				pokemonData.push({
					chartType: 'Area',
					id: idCounter, // Assign ID
					data: [
						{
							title: key,
							value: cleanedValue,
							date: today,
						},
					],
				});
				idCounter += 1; // Increment ID counter
			}
			result.push({ [name]: pokemonData });
		}
	});

	// Wrapping the result in the desired format
	const finalOutput = { DashboardId: 1, dashboardData: result };

	return finalOutput; // Return the final output in the desired format
}

// Handler for file uploads
export const uploadFile = async (req, res) => {
	try {
		if (!req.file) {
			return res.status(400).json({ message: 'No file uploaded' });
		}

		const file = req.file;
		const filePath = path.join(UPLOAD_FOLDER, file.filename);
		const fileType = file.mimetype;

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

		// Use model.predict instead of model.call
		const response = await model.predict(formattedPrompt);

		// The response is a string containing the AI's reply
		const aiResponseContent = response;

		// Extract the JavaScript code containing the data array from the response
		const extractedData = extractJavascriptCode(aiResponseContent);
		const formedData = transformDataStructure(extractedData);
		console.log('data=', JSON.stringify(formedData, null, 4));

		res.json(JSON.stringify(formedData, null, 4));
	} catch (error) {
		console.error('Error processing file:', error);
		res.status(500).json({ error: error.message });
	}
};
