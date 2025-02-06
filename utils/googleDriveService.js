// services/googleDriveService.js
import { google } from 'googleapis';

/**
 * Given a fileId and an auth client,
 * return the Google Drive file's `modifiedTime`.
 */
export async function getGoogleDriveModifiedTime(fileId, authClient) {
	const drive = google.drive({ version: 'v3', auth: authClient });
	const response = await drive.files.get({
		fileId,
		fields: 'id, name, modifiedTime',
	});
	// Example: "modifiedTime": "2025-02-06T13:47:15.000Z"
	return response.data.modifiedTime;
}
