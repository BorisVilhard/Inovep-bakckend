// models/Chat.js

import mongoose from 'mongoose';

const Schema = mongoose.Schema;

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

const ChatSchema = new Schema({
	userId: {
		type: Schema.Types.ObjectId,
		ref: 'User',
		required: true,
		unique: true, // Enforces one chat per user
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
