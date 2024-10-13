// routes/chat.js

import express from 'express';
import {
	createOrUpdateChat,
	getAllChatsForUser,
	getChatById,
	deleteChat,
	verifyUserOwnership,
} from '../controllers/chatController.js';
import verifyJWT from '../middleware/verifyJWT.js';

const router = express.Router();

router.use(verifyJWT);

router
	.route('/users/:userId/chats')
	.get(verifyUserOwnership, getAllChatsForUser)
	.post(verifyUserOwnership, createOrUpdateChat);

router
	.route('/users/:userId/chats/:chatId')
	.get(verifyUserOwnership, getChatById)
	.delete(verifyUserOwnership, deleteChat);

export default router;
