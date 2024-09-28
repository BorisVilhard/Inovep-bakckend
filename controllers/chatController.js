import { PdfReader } from 'pdfreader';
import xlsx from 'xlsx';
import { fileTypeFromBuffer } from 'file-type';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { HttpResponseOutputParser } from 'langchain/output_parsers';

const MAX_MESSAGES = 10;
const MAX_FILE_CONTENT_LENGTH = 1000;

const formatMessage = (message) => {
	return `${message.role}: ${message.content}`;
};

// Updated prompt template with {file_content}
const TEMPLATE = `You are a data analyzer, you are given a data in array and you answer questions regarding the data.

Data provided:
{file_content}

Current conversation:
{chat_history}

user: {input}
assistant:`;

// Function to extract text from file (PDF or Excel)
const extractTextFromFile = async (buffer) => {
	return new Promise(async (resolve, reject) => {
		// Detect the file type from the buffer
		const fileTypeInfo = await fileTypeFromBuffer(buffer);
		const fileType = fileTypeInfo ? fileTypeInfo.mime : null;

		if (fileType === 'application/pdf') {
			// Handle PDF files
			const pdfReader = new PdfReader();
			let extractedText = '';
			pdfReader.parseBuffer(buffer, (err, item) => {
				if (err) {
					console.error('Error parsing PDF:', err);
					reject(new Error('Failed to read PDF content.'));
				} else if (!item) {
					// End of file
					resolve(extractedText.trim());
				} else if (item.text) {
					// Concatenate text items
					extractedText += item.text + ' ';
				}
			});
		} else if (
			fileType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			fileType === 'application/vnd.ms-excel'
		) {
			// Handle Excel files
			try {
				// Read workbook from buffer
				const workbook = xlsx.read(buffer, { type: 'buffer' });
				// Get the first sheet name
				const sheetName = workbook.SheetNames[0];
				const sheet = workbook.Sheets[sheetName];
				// Convert sheet to JSON
				const data = xlsx.utils.sheet_to_json(sheet);
				// Convert JSON data to string
				const extractedText = JSON.stringify(data);
				resolve(extractedText);
			} catch (error) {
				console.error('Error reading Excel file:', error);
				reject(new Error('Failed to read Excel content.'));
			}
		} else {
			reject(new Error('Unsupported file type'));
		}
	});
};

// Function to handle file extraction
const handleFileExtraction = async (fileContent) => {
	try {
		// Create buffer from base64-encoded file content
		const buffer = Buffer.from(fileContent, 'base64');
		const extractedText = await extractTextFromFile(buffer);

		if (!extractedText) {
			return 'The file content appears empty or could not be read properly.';
		}
		// Limit the length of extracted text
		return extractedText.slice(0, MAX_FILE_CONTENT_LENGTH);
	} catch (error) {
		console.error('Error extracting text from file:', error);
		return 'Error reading the file content.';
	}
};

// Main handler function for chat post requests
export const handleChatPost = async (req, res) => {
	try {
		const { messages, fileContent } = req.body;

		// Validate messages
		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({ error: 'Invalid messages format' });
		}

		// Format recent messages
		const recentMessages = messages.slice(-MAX_MESSAGES).map(formatMessage);
		const currentMessageContent = messages.at(-1)?.content || '';

		let extractedText = '';

		// Handle file content if provided
		if (fileContent) {
			extractedText = await handleFileExtraction(fileContent);
			console.log('Extracted Text:', extractedText); // Debugging line
		}

		// Build the chat history without the file content
		const chatHistory = recentMessages.join('\n');
		// Ensure extractedText is not null or undefined
		const fileContentText = extractedText || '';

		// Create prompt
		const prompt = PromptTemplate.fromTemplate(TEMPLATE);

		// Initialize the model
		const model = new ChatOpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			model: 'gpt-3.5-turbo',
			temperature: 0.8,
		});

		// Set up the output parser
		const parser = new HttpResponseOutputParser();
		const chain = prompt.pipe(model).pipe(parser);

		// Get the response stream
		const stream = await chain.stream({
			chat_history: chatHistory,
			file_content: fileContentText,
			input: currentMessageContent,
		});

		// Read and decode the response stream
		const reader = stream.getReader();
		const decoder = new TextDecoder('utf-8');
		let plainText = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			plainText += decoder.decode(value, { stream: true });
		}

		// Send the assistant's response
		res.status(200).send(plainText.trim());
	} catch (error) {
		console.error('Error processing request:', error);
		res.status(error.status ?? 500).json({ error: error.message });
	}
};
