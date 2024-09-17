// chatController.js
import { PdfReader } from 'pdfreader';
import { ChatOpenAI } from '@langchain/openai';
import { PromptTemplate } from '@langchain/core/prompts';
import { HttpResponseOutputParser } from 'langchain/output_parsers';

const MAX_MESSAGES = 10;
const MAX_FILE_CONTENT_LENGTH = 1000;

const formatMessage = (message) => {
	return `${message.role}: ${message.content}`;
};

const TEMPLATE = `You are a helpful assistant providing users information from their PDF CV's.

Current conversation:
{chat_history}

user: {input}
assistant:`;

const extractTextFromPDF = async (buffer) => {
	return new Promise((resolve, reject) => {
		const pdfReader = new PdfReader();
		let extractedText = '';

		pdfReader.parseBuffer(buffer, (err, item) => {
			if (err) {
				console.error('Error parsing PDF:', err);
				reject(new Error('Failed to read PDF content.'));
			} else if (!item) {
				resolve(extractedText.trim());
			} else if (item.text) {
				extractedText += item.text + ' ';
			}
		});
	});
};

const handleFileExtraction = async (fileContent) => {
	try {
		const pdfBuffer = Buffer.from(fileContent, 'base64');
		const extractedText = await extractTextFromPDF(pdfBuffer);

		if (!extractedText) {
			return 'The PDF content appears empty or could not be read properly.';
		}
		return extractedText.slice(0, MAX_FILE_CONTENT_LENGTH);
	} catch (error) {
		console.error('Error extracting text from PDF:', error);
		return 'Error reading the PDF content.';
	}
};

export const handleChatPost = async (req, res) => {
	try {
		const { messages, fileContent } = req.body;

		if (!messages || !Array.isArray(messages)) {
			return res.status(400).json({ error: 'Invalid messages format' });
		}

		const recentMessages = messages.slice(-MAX_MESSAGES).map(formatMessage);
		const currentMessageContent = messages.at(-1)?.content || '';

		let extractedText = '';

		if (fileContent) {
			extractedText = await handleFileExtraction(fileContent);
		}

		const chatHistoryWithFileContent = extractedText
			? `${recentMessages.join('\n')}\nFile Content:\n${extractedText}`
			: recentMessages.join('\n');

		const prompt = PromptTemplate.fromTemplate(TEMPLATE);

		const model = new ChatOpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			model: 'gpt-3.5-turbo',
			temperature: 0.8,
		});

		const parser = new HttpResponseOutputParser();
		const chain = prompt.pipe(model).pipe(parser);

		const stream = await chain.stream({
			chat_history: chatHistoryWithFileContent,
			input: currentMessageContent,
		});

		const reader = stream.getReader();
		const decoder = new TextDecoder('utf-8');
		let plainText = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			plainText += decoder.decode(value, { stream: true });
		}

		res.status(200).send(plainText.trim());
	} catch (error) {
		console.error('Error processing request:', error);
		res.status(error.status ?? 500).json({ error: error.message });
	}
};
