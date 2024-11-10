import express from 'express';
import { handleLogin } from '../controllers/authController.js';
import { handleGoogleAuth } from '../controllers/googleAuthController.js';

const router = express.Router();

router.post('/', handleLogin);
router.post('/google', handleGoogleAuth);

export default router;
