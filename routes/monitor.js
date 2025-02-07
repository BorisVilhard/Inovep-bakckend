import express from 'express';
import {
	setupFileMonitoring,
	setupFolderMonitoring,
	handleNotification,
	renewFileChannel,
	stopFileMonitoring,
} from '../controllers/monitorController.js';

const router = express.Router();

// Single-file watch (requires logged-in user)
router.post('/', setupFileMonitoring);
router.post('/folder', setupFolderMonitoring);
router.post('/renew', renewFileChannel);
router.post('/stop', stopFileMonitoring);
router.post('/notifications', handleNotification);

export default router;
