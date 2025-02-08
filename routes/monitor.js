import express from 'express';
import {
	setupFileMonitoring,
	setupFolderMonitoring,
	handleNotification,
	renewFileChannel,
	stopFileMonitoring,
	stopFolderMonitoring,
} from '../controllers/monitorController.js';

const router = express.Router();

// Single-file watch
router.post('/', setupFileMonitoring);

// Folder watch
router.post('/folder', setupFolderMonitoring);

// Renew single-file watch
router.post('/renew', renewFileChannel);

// Stop single-file watch
router.post('/stop', stopFileMonitoring);

// Stop folder watch
router.post('/folder/stop', stopFolderMonitoring);

// Google webhook notifications (common endpoint for file & folder)
router.post('/notifications', handleNotification);

export default router;
