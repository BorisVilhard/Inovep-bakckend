// controllers/monitorController.js

import { google } from 'googleapis';
import { getTokens, saveTokens } from '../tokenStore.js';

// In-memory state for demonstration
let updateCounter = 0;
let monitoredFolderId = null;
let changesPageToken = null;

// Map to track last known modifiedTime for each fileId
const fileModificationTimes = {};

/**
 * Sets up monitoring for a single file.
 */
export async function setupFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).send('Missing fileId');
		}

		const { access_token, refresh_token, expiry_date } = getTokens();
		if (!access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}

		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken(); // Auto-refresh if expired
		saveTokens(oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`, // Unique channel ID
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
			},
		});

		console.log('Single-file watch response:', watchResponse.data);

		// Initialize fileModificationTimes for single-file monitoring
		const fileMeta = await drive.files.get({ fileId, fields: 'modifiedTime' });
		fileModificationTimes[fileId] = fileMeta.data.modifiedTime;

		return res.status(200).send('Monitoring started for file');
	} catch (error) {
		console.error('Error setting up file watch:', error);
		return res.status(500).send('Error setting up file watch');
	}
}

/**
 * Sets up monitoring for a folder.
 */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}
		monitoredFolderId = folderId; // Store globally or in a DB for multi-user

		const { access_token, refresh_token, expiry_date } = getTokens();
		if (!access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}

		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken(); // Auto-refresh if needed
		saveTokens(oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// 1) Retrieve and parse all existing files in the folder
		await retrieveAllFilesInFolder(folderId, drive, oauth2Client);

		// 2) Get a start page token for changes
		const startPageTokenResp = await drive.changes.getStartPageToken();
		changesPageToken = startPageTokenResp.data.startPageToken;
		console.log('Start page token:', changesPageToken);

		// 3) Watch changes
		const watchResponse = await drive.changes.watch({
			pageToken: changesPageToken,
			requestBody: {
				id: `watch-changes-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
			},
		});

		console.log('Folder watch response:', watchResponse.data);
		return res.status(200).send('Monitoring started for folder');
	} catch (error) {
		console.error('Error setting up folder watch:', error);
		return res.status(500).send('Error setting up folder watch');
	}
}

/**
 * Handles incoming push notifications from Google APIs.
 */
export async function handleNotification(req, res) {
	const io = req.app.get('io');
	const resourceUri = req.headers['x-goog-resource-uri'] || '';
	console.log('Push notification resourceUri:', resourceUri);

	try {
		if (resourceUri.includes('/files/')) {
			// Single-file watch
			await handleSingleFileNotification(resourceUri, io);
		} else if (resourceUri.includes('/changes')) {
			// Folder watch approach
			await handleChangesNotification(io);
		}
	} catch (err) {
		console.error('Error in handleNotification:', err);
	}

	return res.status(200).send('Notification received');
}

/* ----------------- Helpers ----------------- */

/**
 * Handles notifications for single-file monitoring.
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	const { access_token, refresh_token, expiry_date } = getTokens();
	if (!access_token) return; // No tokens => can't fetch

	const oauth2Client = createOAuthClient(
		access_token,
		refresh_token,
		expiry_date
	);
	const drive = google.drive({ version: 'v3', auth: oauth2Client });

	try {
		const fileMeta = await drive.files.get({
			fileId,
			fields: 'modifiedTime, mimeType',
		});
		const currentModifiedTime = fileMeta.data.modifiedTime;
		const mimeType = fileMeta.data.mimeType;

		// Check if modifiedTime has changed
		if (fileModificationTimes[fileId] !== currentModifiedTime) {
			fileModificationTimes[fileId] = currentModifiedTime; // Update stored time
			await fetchAndEmitFileContent(fileId, oauth2Client, io, false); // emitToRoom=false (already in room)
		} else {
			console.log(`No content change detected for fileId: ${fileId}`);
		}
	} catch (err) {
		console.error(
			`Error handling single file notification for fileId ${fileId}:`,
			err.response?.data || err.message
		);
	}
}

/**
 * Handles notifications for folder monitoring.
 */
async function handleChangesNotification(io) {
	if (!monitoredFolderId || !changesPageToken) {
		console.log('No folder monitored or no pageToken');
		return;
	}

	const { access_token, refresh_token, expiry_date } = getTokens();
	if (!access_token) return;

	const oauth2Client = createOAuthClient(
		access_token,
		refresh_token,
		expiry_date
	);
	const drive = google.drive({ version: 'v3', auth: oauth2Client });

	try {
		const changesResp = await drive.changes.list({
			pageToken: changesPageToken,
			spaces: 'drive',
			fields: 'newStartPageToken, nextPageToken, changes(fileId, removed)',
		});

		const changes = changesResp.data.changes || [];
		for (const c of changes) {
			const fileId = c.fileId;
			if (c.removed) {
				// File was removed; handle if necessary
				console.log(`File removed: ${fileId}`);
				delete fileModificationTimes[fileId];
				continue;
			}

			// Check if the file is in the monitored folder
			try {
				const fileMeta = await drive.files.get({
					fileId,
					fields: 'id, parents, modifiedTime, mimeType, name',
				});
				const parents = fileMeta.data.parents || [];
				if (parents.includes(monitoredFolderId)) {
					const currentModifiedTime = fileMeta.data.modifiedTime;
					const mimeType = fileMeta.data.mimeType;
					const fileName = fileMeta.data.name;

					// If file is new or modified
					if (
						!fileModificationTimes[fileId] || // New file
						fileModificationTimes[fileId] !== currentModifiedTime // Modified
					) {
						fileModificationTimes[fileId] = currentModifiedTime; // Update stored time
						await fetchAndEmitFileContent(fileId, oauth2Client, io, true); // emitGlobally=true
					} else {
						console.log(`No content change detected for fileId: ${fileId}`);
					}
				}
			} catch (fileErr) {
				console.error(
					`Error fetching metadata for fileId ${fileId}:`,
					fileErr.response?.data || fileErr.message
				);
			}
		}

		// Update pageToken
		if (changesResp.data.newStartPageToken) {
			changesPageToken = changesResp.data.newStartPageToken;
		} else if (changesResp.data.nextPageToken) {
			changesPageToken = changesResp.data.nextPageToken;
		}
	} catch (err) {
		console.error(
			'Error listing or processing changes:',
			err.response?.data || err.message
		);
	}
}

/**
 * Retrieves all files in a folder and initializes their modification times.
 */
async function retrieveAllFilesInFolder(folderId, drive, oauth2Client) {
	console.log('Retrieving all files in folder', folderId);

	let nextPageToken = null;
	do {
		const resp = await drive.files.list({
			q: `'${folderId}' in parents and trashed=false`,
			fields: 'files(id, name, mimeType, modifiedTime), nextPageToken',
			pageSize: 50,
			pageToken: nextPageToken || undefined,
		});

		const files = resp.data.files || [];
		for (const f of files) {
			// Initialize modifiedTime
			fileModificationTimes[f.id] = f.modifiedTime;

			// Optionally, emit initial content if desired
			// Here, we set emitEvent=false to avoid emitting on initial load
			await fetchAndEmitFileContent(f.id, oauth2Client, null, false);
		}

		nextPageToken = resp.data.nextPageToken;
	} while (nextPageToken);
}

/**
 * Fetches and emits the content of a file.
 */
async function fetchAndEmitFileContent(
	fileId,
	oauth2Client,
	io,
	emitGlobally = false
) {
	try {
		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		const meta = await drive.files.get({
			fileId,
			fields: 'id, name, mimeType',
		});
		const { mimeType, name } = meta.data;

		let fileContent = '';
		if (mimeType === 'application/vnd.google-apps.document') {
			// Google Docs => call docs API
			const docs = google.docs({ version: 'v1', auth: oauth2Client });
			const docResp = await docs.documents.get({ documentId: fileId });
			fileContent = extractPlainText(docResp.data);
		} else if (mimeType === 'text/csv') {
			// Raw CSV
			const csvResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');
		} else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
			// Google Sheets => export as CSV and parse
			const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
			// List all sheets in the spreadsheet
			const spreadsheet = await sheets.spreadsheets.get({
				spreadsheetId: fileId,
				fields: 'sheets(properties(title,sheetId))',
			});

			const sheetTitles = spreadsheet.data.sheets.map(
				(sheet) => sheet.properties.title
			);

			// Fetch CSV for each sheet and concatenate
			let allSheetsContent = '';
			for (const title of sheetTitles) {
				try {
					const csvResp = await drive.files.export(
						{
							fileId,
							mimeType: 'text/csv',
						},
						{ responseType: 'arraybuffer' }
					);
					const sheetContent = Buffer.from(csvResp.data).toString('utf8');
					allSheetsContent += `--- Sheet: ${title} ---\n${sheetContent}\n\n`;
				} catch (exportErr) {
					console.error(
						`Error exporting sheet "${title}" as CSV:`,
						exportErr.response?.data || exportErr.message
					);
					continue; // Proceed with other sheets
				}
			}

			fileContent = allSheetsContent.trim();
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			// Skip folders
			return;
		} else {
			// Handle other supported MIME types if needed
			fileContent = `Unsupported or unhandled file type: ${mimeType}. Name: ${name}`;
		}

		updateCounter += 1;
		console.log(`Fetched content for file: ${name} (#${updateCounter})`);

		// If we want real-time broadcast
		if (io && fileContent) {
			const eventPayload = {
				fileId,
				message: `File "${name}" updated (Update #${updateCounter}).`,
				updateIndex: updateCounter,
				fullText: fileContent,
			};

			if (emitGlobally) {
				io.emit('file-updated', eventPayload);
			} else {
				io.to(fileId).emit('file-updated', eventPayload);
			}
		}
	} catch (err) {
		if (err.response && err.response.data) {
			console.error(
				'Error fetching file content:',
				JSON.stringify(err.response.data, null, 2)
			);
		} else {
			console.error('Error fetching file content:', err.message);
		}
	}
}

/**
 * Extracts plain text from a Google Docs document.
 */
function extractPlainText(doc) {
	if (!doc.body || !doc.body.content) return '';
	let text = '';
	for (const element of doc.body.content) {
		if (element.paragraph?.elements) {
			for (const pe of element.paragraph.elements) {
				if (pe.textRun?.content) {
					text += pe.textRun.content;
				}
			}
			text += '\n';
		}
	}
	return text.trim();
}

/**
 * Creates an OAuth2 client.
 */
function createOAuthClient(access_token, refresh_token, expiry_date) {
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
