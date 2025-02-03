// controllers/monitorController.js

import { google } from 'googleapis';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { getTokens, saveTokens } from '../tokenStore.js';

/**
 * In-memory state for demo purposes.
 */
let updateCounter = 0;
let monitoredFolderId = null;
let changesPageToken = null;
const fileModificationTimes = {};

// Mapping files/folders to user IDs.
const fileUserMapping = {}; // key: fileId, value: userId
const folderUserMapping = {}; // key: folderId, value: userId

/**
 * Helper to extract a user ID from the request.
 * For interactive endpoints, we expect the frontend to send a valid user ID.
 */
function getUserId(req) {
	return req.user ? req.user.id : req.body.userId || req.query.userId;
}

/**
 * Helper to check if a given id is a valid ObjectId.
 */
function isValidObjectId(id) {
	return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Creates an OAuth2 client with the provided credentials.
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

/**
 * Sets up monitoring for a single file in Drive.
 * Expects { fileId, userId } in req.body.
 */
export async function setupFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).send('Missing fileId');
		}

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		// Save the user mapping for this file.
		fileUserMapping[fileId] = userId;

		// Retrieve tokens for this user.
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// Create and initialize the OAuth2 client.
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		// Refresh the token if needed.
		await oauth2Client.getAccessToken();
		// Save any updated tokens.
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Set channel expiration to 7 days from now.
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		// Start watching the file – include the expiration parameter.
		await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		// Get the file's current modification time.
		const fileMeta = await drive.files.get({
			fileId,
			fields: 'modifiedTime, name',
		});
		fileModificationTimes[fileId] = fileMeta.data.modifiedTime;

		return res.status(200).json({
			message: 'Monitoring started for file',
			fileId,
			channelExpiration: expiration,
			expirationDate: new Date(expiration).toLocaleString(),
		});
	} catch (error) {
		console.error('Error setting up file watch:', error);
		return res.status(500).send('Error setting up file watch');
	}
}

/**
 * Sets up monitoring for a folder in Drive.
 * Expects { folderId, userId } in req.body.
 */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}
		monitoredFolderId = folderId;

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		// Save the user mapping for this folder.
		folderUserMapping[folderId] = userId;

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// 1) Retrieve & parse all existing files in the folder.
		await retrieveAllFilesInFolder(folderId, drive, oauth2Client);

		// 2) Get a start page token for changes.
		const startPageTokenResp = await drive.changes.getStartPageToken();
		changesPageToken = startPageTokenResp.data.startPageToken;
		console.log('Start page token:', changesPageToken);

		// Set channel expiration to 7 days from now.
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		// 3) Watch for changes with expiration.
		await drive.changes.watch({
			pageToken: changesPageToken,
			requestBody: {
				id: `watch-changes-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		console.log('Folder watch response:', { expiration });
		return res.status(200).json({
			message: 'Monitoring started for folder',
			folderId,
			channelExpiration: expiration,
			expirationDate: new Date(expiration).toLocaleString(),
		});
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
			// Single-file notification.
			await handleSingleFileNotification(resourceUri, io);
		} else if (resourceUri.includes('/changes')) {
			// Folder-level notification.
			await handleChangesNotification(io);
		}
	} catch (err) {
		console.error('Error in handleNotification:', err);
	}

	return res.status(200).send('Notification received');
}

/**
 * Endpoint to renew the file watch channel.
 * Expects { fileId, userId } in req.body.
 */
export async function renewFileChannel(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).send('Missing fileId');
		}
		const userId = req.body.userId || getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res.status(401).send('No stored access token.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		// Renew channel: new expiration 7 days from now.
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;
		await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		// Update mapping if necessary.
		fileUserMapping[fileId] = userId;

		console.log(
			`Channel for file ${fileId} renewed until ${new Date(
				expiration
			).toLocaleString()}`
		);

		return res.status(200).json({
			message: 'Channel renewed successfully',
			fileId,
			channelExpiration: expiration,
			expirationDate: new Date(expiration).toLocaleString(),
		});
	} catch (error) {
		console.error('Error renewing file watch:', error);
		return res.status(500).send('Error renewing file watch');
	}
}

/* -------------------------------
   Helper Functions
---------------------------------*/

/**
 * Handles a single-file change notification.
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	// Look up the user ID from the mapping.
	const userId = fileUserMapping[fileId];
	if (!userId) {
		console.error(`No user mapping found for fileId: ${fileId}`);
		return;
	}
	if (!isValidObjectId(userId)) {
		console.error(`Invalid user ID provided for webhook: ${userId}`);
		return;
	}

	const tokens = await getTokens(userId);
	if (!tokens || !tokens.access_token) return;

	const { access_token, refresh_token, expiry_date } = tokens;
	const oauth2Client = createOAuthClient(
		access_token,
		refresh_token,
		expiry_date
	);
	const drive = google.drive({ version: 'v3', auth: oauth2Client });

	try {
		const fileMeta = await drive.files.get({
			fileId,
			fields: 'id, name, mimeType, modifiedTime',
		});
		const currentModifiedTime = fileMeta.data.modifiedTime;
		const fileNameFromMeta = fileMeta.data.name || 'cloud_file';

		if (fileModificationTimes[fileId] !== currentModifiedTime) {
			fileModificationTimes[fileId] = currentModifiedTime;
			await fetchAndEmitFileContent(
				fileId,
				oauth2Client,
				io,
				false,
				fileNameFromMeta
			);
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
 * Handles a folder-level change notification.
 */
async function handleChangesNotification(io) {
	if (!monitoredFolderId || !changesPageToken) {
		console.log('No folder monitored or no pageToken');
		return;
	}

	const userId = folderUserMapping[monitoredFolderId];
	if (!userId) {
		console.error(`No user mapping found for folderId: ${monitoredFolderId}`);
		return;
	}
	if (!isValidObjectId(userId)) {
		console.error(`Invalid user ID provided for webhook: ${userId}`);
		return;
	}

	const tokens = await getTokens(userId);
	if (!tokens || !tokens.access_token) return;

	const { access_token, refresh_token, expiry_date } = tokens;
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
				console.log(`File removed: ${fileId}`);
				delete fileModificationTimes[fileId];
				continue;
			}
			try {
				const fileMeta = await drive.files.get({
					fileId,
					fields: 'id, parents, modifiedTime, mimeType, name',
				});
				const parents = fileMeta.data.parents || [];
				const currentModifiedTime = fileMeta.data.modifiedTime;
				const fileNameFromMeta = fileMeta.data.name;

				if (parents.includes(monitoredFolderId)) {
					if (
						!fileModificationTimes[fileId] ||
						fileModificationTimes[fileId] !== currentModifiedTime
					) {
						fileModificationTimes[fileId] = currentModifiedTime;
						await fetchAndEmitFileContent(
							fileId,
							oauth2Client,
							io,
							true,
							fileNameFromMeta
						);
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
			fileModificationTimes[f.id] = f.modifiedTime;
			await fetchAndEmitFileContent(
				f.id,
				oauth2Client,
				null,
				false,
				f.name || 'cloud_file'
			);
		}
		nextPageToken = resp.data.nextPageToken;
	} while (nextPageToken);
}

/**
 * Fetches and emits file content from Drive.
 * Supports multiple file types (Google Docs, CSV, XLSX, Google Sheets, etc.).
 */
async function fetchAndEmitFileContent(
	fileId,
	oauth2Client,
	io,
	emitGlobally,
	actualFileName
) {
	try {
		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		const meta = await drive.files.get({
			fileId,
			fields: 'mimeType',
		});
		const { mimeType } = meta.data;
		let fileContent = '';

		if (mimeType === 'application/vnd.google-apps.document') {
			const docs = google.docs({ version: 'v1', auth: oauth2Client });
			const docResp = await docs.documents.get({ documentId: fileId });
			fileContent = extractPlainText(docResp.data);
		} else if (mimeType === 'text/csv') {
			const csvResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');
		} else if (
			mimeType ===
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		) {
			const xlsxResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			const workbook = XLSX.read(new Uint8Array(xlsxResp.data), {
				type: 'array',
			});
			let allSheetsContent = '';
			workbook.SheetNames.forEach((sheetName) => {
				const worksheet = workbook.Sheets[sheetName];
				const csv = XLSX.utils.sheet_to_csv(worksheet);
				allSheetsContent += `--- Sheet: ${sheetName} ---\n${csv}\n\n`;
			});
			fileContent = allSheetsContent.trim();
		} else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
			const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
			const spreadsheet = await sheets.spreadsheets.get({
				spreadsheetId: fileId,
				fields: 'sheets(properties(title,sheetId))',
			});
			const sheetTitles = spreadsheet.data.sheets.map(
				(s) => s.properties.title
			);
			let allSheetsContent = '';
			for (const title of sheetTitles) {
				try {
					const csvResp = await drive.files.export(
						{ fileId, mimeType: 'text/csv' },
						{ responseType: 'arraybuffer' }
					);
					const sheetContent = Buffer.from(csvResp.data).toString('utf8');
					allSheetsContent += `--- Sheet: ${title} ---\n${sheetContent}\n\n`;
				} catch (exportErr) {
					console.error(
						`Error exporting sheet "${title}" as CSV:`,
						exportErr.response?.data || exportErr.message
					);
					continue;
				}
			}
			fileContent = allSheetsContent.trim();
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			// Skip folders.
			return;
		} else {
			fileContent = `Unsupported or unhandled file type: ${mimeType}`;
		}

		fileContent = removeSheetHeaders(fileContent);
		updateCounter += 1;
		console.log(
			`Fetched content for file: ${actualFileName} (#${updateCounter})`
		);

		if (io && fileContent) {
			const eventPayload = {
				fileId,
				fileName: actualFileName,
				message: `File "${actualFileName}" updated (Update #${updateCounter}).`,
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
 * Extracts plain text from a Google Doc.
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
 * Removes lines like `--- Sheet: SheetName ---` from the text.
 */
function removeSheetHeaders(text) {
	return text.replace(/^--- Sheet: .*? ---\r?\n?/gm, '').trim();
}
