import express from 'express';
import {
	handleLogin,
	handleRefreshToken,
} from '../controllers/authController.js';
import { handleGoogleAuth } from '../controllers/googleAuthController.js';
import { google } from 'googleapis';
// routes/authRoutes.js
import { saveTokens, getTokens } from '../tokenStore.js';

const router = express.Router();

router.post('/', handleLogin);
router.get('/refresh-token', handleRefreshToken);
router.post('/google', handleGoogleAuth);

router.post('/exchange-code', async (req, res) => {
	const { code } = req.body;
	if (!code) return res.status(400).send('Missing auth code');

	try {
		// Create OAuth2 client
		const oauth2Client = new google.auth.OAuth2(
			process.env.GOOGLE_CLIENT_ID,
			process.env.GOOGLE_CLIENT_SECRET,
			process.env.GOOGLE_REDIRECT_URI
		);

		// Exchange the code for tokens
		const { tokens } = await oauth2Client.getToken(code);
		// tokens => { access_token, refresh_token, scope, id_token, token_type, expiry_date }

		console.log('Tokens after code exchange:', tokens);
		saveTokens(tokens);

		return res.status(200).send('Tokens saved successfully');
	} catch (error) {
		console.error('Error exchanging code:', error);
		return res.status(500).send('Failed to exchange code');
	}
});

router.get('/current-token', (req, res) => {
	const { access_token } = getTokens();
	if (!access_token) {
		return res.status(401).json({ error: 'No access token available' });
	}
	return res.status(200).json({ accessToken: access_token });
});

export default router;
