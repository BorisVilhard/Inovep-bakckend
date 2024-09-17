// chatRoute.js

import express from 'express';
import { handleChatPost } from '../controllers/chatController.js';

const router = express.Router();

// Define the POST route for chat handling
router.post('/', handleChatPost);

export default router;
