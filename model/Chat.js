// models/Chat.js

import mongoose from 'mongoose';

const Schema = mongoose.Schema;

// Define MessageSchema
const MessageSchema = new Schema({
	role: {
		type: String,
		enum: ['user', 'assistant', 'system'],
		required: true,
	},
	content: {
		type: String,
		required: true,
	},
	timestamp: {
		type: Date,
		default: Date.now,
	},
});

// Define ChatSchema
const ChatSchema = new Schema({
	userId: {
		type: Schema.Types.ObjectId,
		ref: 'User',
		required: true,
		// unique: true, // Removed to allow multiple chats per user
	},
	dashboardId: {
		type: Schema.Types.ObjectId,
		ref: 'Dashboard',
		required: true,
	},
	dashboardName: {
		type: String,
		required: true,
	},
	messages: {
		type: [MessageSchema],
		required: true,
		default: [],
	},
	fileContent: {
		type: String,
		default: '',
	},
	createdAt: {
		type: Date,
		default: Date.now,
	},
});

export default mongoose.model('Chat', ChatSchema);
