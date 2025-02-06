import { google } from 'googleapis';

export function getUserAuthClient(access_token, refresh_token, expiry_date) {
	const oauth2Client = new google.auth.OAuth2(
		process.env.GOOGLE_CLIENT_ID,
		process.env.GOOGLE_CLIENT_SECRET,
		process.env.GOOGLE_REDIRECT_URI
	);
	oauth2Client.setCredentials({
		access_token,
		refresh_token,
		expiry_date,
	});
	return oauth2Client;
}
