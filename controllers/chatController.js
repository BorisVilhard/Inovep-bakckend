// controllers/chatController.js
import { ChatOpenAI } from '@langchain/openai';
// controllers/chatController.js

import Chat from '../model/Chat.js';
import mongoose from 'mongoose';
import { PdfReader } from 'pdfreader';
import xlsx from 'xlsx';
import { fileTypeFromBuffer } from 'file-type';

import { PromptTemplate } from "@langchain/core/prompts";
import { LLMChain } from "langchain/chains";

// Constants
const MAX_MESSAGES = 10;
const MAX_FILE_CONTENT_LENGTH = 1000;

const formatMessage = (message) => {
	return `${message.role}: ${message.content}`;
};

// Updated prompt template with {file_content}
const TEMPLATE = `You are a data analyzer, you are given data in an array and you answer questions regarding the data.

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

// Verify User Ownership Middleware
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user.id;
	const userIdFromParams = req.params.userId;

	if (userIdFromToken !== userIdFromParams) {
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
};

// Create or update a chat for a user
export const createOrUpdateChat = async (req, res) => {
	try {
		const { userId } = req.params;
		const { messages, fileContent, dashboardId, dashboardName, dashboardData } =
			req.body;

		// Validate messages
		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({ error: 'Invalid messages format' });
		}

		// Validate dashboardId and dashboardName
		if (!dashboardId || !dashboardName) {
			return res
				.status(400)
				.json({ error: 'dashboardId and dashboardName are required' });
		}

		// Check if a chat exists for the user and dashboard
		let chat = await Chat.findOne({ userId, dashboardId });

		let isNewChat = false;
		if (!chat) {
			isNewChat = true;
			chat = new Chat({
				userId,
				dashboardId,
				dashboardName,
				messages: [],
			});
		}

		// Handle file content if provided
		if (fileContent) {
			const extractedText = await handleFileExtraction(fileContent);
			chat.fileContent = extractedText || '';
		}

		// Use dashboardData as fileContent if provided
		if (dashboardData) {
			chat.fileContent = JSON.stringify(dashboardData).slice(
				0,
				MAX_FILE_CONTENT_LENGTH
			);
		}

		// Format recent messages
		const recentMessages = chat.messages
			.slice(-MAX_MESSAGES)
			.map(formatMessage);
		// Append new user messages
		const newUserMessages = messages.map(formatMessage);
		const allRecentMessages = [...recentMessages, ...newUserMessages].slice(
			-MAX_MESSAGES
		);

		const chatHistory = allRecentMessages.join('\n');
		const fileContentText = chat.fileContent || '';

		// Create prompt
		const prompt = new PromptTemplate({
			template: TEMPLATE,
			inputVariables: ['chat_history', 'file_content', 'input'],
		});

		// Initialize the model
		const model = new ChatOpenAI({
			openAIApiKey: process.env.OPENAI_API_KEY,
			modelName: 'gpt-4-turbo',
			temperature: 0.8,
		});

		// Create the chain
		const chain = new LLMChain({ llm: model, prompt });

		// Get the assistant's response
		const assistantResponse = await chain.call({
			chat_history: chatHistory,
			file_content: fileContentText,
			input: messages.at(-1)?.content || '',
		});

		const assistantText = assistantResponse.text.trim();

		// Create assistant's message
		const assistantMessage = { role: 'assistant', content: assistantText };

		// Append user's messages and assistant's response to chat
		messages.forEach((msg) => chat.messages.push(msg));
		chat.messages.push(assistantMessage);

		// Save the chat
		await chat.save();

		// Return the assistant's response and chatId if new chat was created
		const responseData = { message: assistantText };
		if (isNewChat) {
			responseData.chatId = chat._id;
			responseData.chat = chat; // Include chat data
		}

		res.status(200).json(responseData);
	} catch (error) {
		console.error('Error processing request:', error);
		res.status(error.status ?? 500).json({ error: error.message });
	}
};

// Delete a chat for a user
export const deleteChat = async (req, res) => {
	const userId = req.params.userId;
	const { chatId } = req.params;

	if (!mongoose.Types.ObjectId.isValid(chatId)) {
		return res.status(400).json({ message: 'Invalid chat ID' });
	}

	try {
		const chat = await Chat.findOne({ _id: chatId, userId });
		if (!chat) {
			return res.status(404).json({ message: `Chat ID ${chatId} not found` });
		}

		await chat.deleteOne();
		res.json({ message: 'Chat deleted successfully' });
	} catch (error) {
		console.error('Error deleting chat:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

// controllers/chatController.js

export const getAllChatsForUser = async (req, res) => {
	const userId = req.params.userId;
	try {
		const chats = await Chat.find({ userId })
			.select('_id createdAt dashboardId dashboardName')
			.sort({ createdAt: -1 });
		if (!chats || chats.length === 0) {
			return res.status(204).json({ message: 'No chats found' });
		}
		res.json(chats);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

export const getChatById = async (req, res) => {
	const userId = req.params.userId;
	const { chatId } = req.params;
	try {
		if (!mongoose.Types.ObjectId.isValid(chatId)) {
			return res.status(400).json({ message: 'Invalid chat ID' });
		}
		const chat = await Chat.findOne({ _id: chatId, userId });
		if (!chat) {
			return res.status(404).json({ message: `Chat ID ${chatId} not found` });
		}
		res.json(chat); // Returns the entire chat document
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};
