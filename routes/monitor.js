import express from 'express';
import {
	setupFileMonitoring,
	setupFolderMonitoring,
	handleNotification,
} from '../controllers/monitorController.js';

const router = express.Router();

// Single-file watch (requires logged-in user)
router.post('/', setupFileMonitoring);

// Folder watch (requires logged-in user)
router.post('/folder', setupFolderMonitoring);

// Google sends notifications here (no auth token)
router.post('/notifications', handleNotification);

export default router;
