import { google } from 'googleapis';

export async function getUserAuthClient(
	access_token,
	refresh_token,
	expiry_date
) {
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

	try {
		// This will refresh the token if expired
		const tokenResponse = await oauth2Client.getAccessToken();
		if (tokenResponse.token) {
			oauth2Client.setCredentials({
				...oauth2Client.credentials,
				access_token: tokenResponse.token,
			});
		}
	} catch (error) {
		console.error('Failed to refresh access token:', error);
		throw error;
	}

	return oauth2Client;
}
