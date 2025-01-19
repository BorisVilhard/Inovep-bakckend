// authMiddleware.js
import { google } from 'googleapis';

const verifyGoogleAccessToken = async (accessToken) => {
	const oauth2Client = new google.auth.OAuth2();
	// This throws if the token is invalid or expired
	return await oauth2Client.getTokenInfo(accessToken);
};

export const authenticate = async (req, res, next) => {
	const authHeader = req.headers.authorization;
	if (!authHeader) {
		return res.status(401).send('Missing Authorization header');
	}

	const accessToken = authHeader.split(' ')[1];

	try {
		const tokenInfo = await verifyGoogleAccessToken(accessToken);
		if (!tokenInfo) {
			// If by some chance tokenInfo is null/undefined, handle it
			return res.status(401).send('Token info is undefined');
		}

		console.log('tokenInfo is:', tokenInfo);
		// Expecting something like:
		// {
		//   "aud": "...",
		//   "user_id": "...",
		//   "scope": "https://www.googleapis.com/auth/drive ...",
		//   "expires_in": 3599,
		//   "email": "...",
		//   "verified_email": true
		// }

		// If scope is missing or undefined, handle gracefully
		if (
			!Array.isArray(tokenInfo.scopes) ||
			!tokenInfo.scopes.includes('https://www.googleapis.com/auth/drive')
		) {
			return res.status(403).send('Insufficient Drive scopes');
		}

		// Attach user data to the request if you want
		req.user = {
			googleUserId: tokenInfo.user_id,
			email: tokenInfo.email,
			scopes: tokenInfo.scope,
		};

		// Proceed to next middleware/route
		next();
	} catch (error) {
		console.error('Access token verification failed:', error);
		return res.status(401).send('Invalid or expired access token');
	}
};
