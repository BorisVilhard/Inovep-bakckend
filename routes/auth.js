import express from 'express';
import {
	handleLogin,
	handleRefreshToken,
} from '../controllers/authController.js';
import { handleGoogleAuth } from '../controllers/googleAuthController.js';

const router = express.Router();

router.post('/', handleLogin);
router.get('/refresh-token', handleRefreshToken);
router.post('/google', handleGoogleAuth);

export default router;
