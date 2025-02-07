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

// Tracks the last-known modifiedTime for each file.
const fileModificationTimes = {};

// Mapping files/folders to user IDs.
const fileUserMapping = {}; // key: fileId, value: userId
const folderUserMapping = {}; // key: folderId, value: userId

// For storing watch channel info so we can call `drive.channels.stop()` later.
// Key: fileId, Value: { channelId, resourceId }
const channelMap = {};

/**
 * Helper to extract a user ID from the request (depending on your auth strategy).
 */
function getUserId(req) {
	return req.user ? req.user.id : req.body.userId || req.query.userId;
}

/**
 * Helper to check if a given id is a valid MongoDB ObjectId.
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
 * Sets up monitoring for a single file in Google Drive.
 * Expects { fileId, userId } in req.body.
 * Immediately fetches & emits file content, then only re-emits if the file changes.
 */
export async function setupFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).send('Missing fileId');
		}

		// Validate user
		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		fileUserMapping[fileId] = userId;

		// Retrieve tokens
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// Create OAuth client & refresh token if needed
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Expire channel in 7 days
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		// Start watching the file
		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`, // Unique channel ID
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		// Capture resource & channel IDs so we can stop later
		const { resourceId, id: channelId } = watchResponse.data || {};
		if (!resourceId || !channelId) {
			console.warn(
				'Missing resourceId or channelId in watch response:',
				watchResponse.data
			);
		} else {
			channelMap[fileId] = { resourceId, channelId };
		}

		// Retrieve file's current modifiedTime & name
		const fileMeta = await drive.files.get({
			fileId,
			fields: 'modifiedTime, name',
		});
		const currentModifiedTime =
			fileMeta.data.modifiedTime || new Date().toISOString();
		const fileNameFromMeta = fileMeta.data.name || 'cloud_file';

		// Store the last-known modified time
		fileModificationTimes[fileId] = currentModifiedTime;

		// Immediately fetch & emit the current content
		const io = req.app.get('io'); // your Socket.io instance
		await fetchAndEmitFileContent(
			fileId,
			oauth2Client,
			io,
			false,
			fileNameFromMeta
		);

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
 * Immediately fetches & emits content for each file in the folder,
 * then only re-emits on subsequent changes.
 */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}
		monitoredFolderId = folderId;

		// Validate user
		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

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

		// 1) Retrieve & parse all existing files in the folder (fetch & emit them)
		await retrieveAllFilesInFolder(folderId, drive, oauth2Client);

		// 2) Get a start page token for changes
		const startPageTokenResp = await drive.changes.getStartPageToken();
		changesPageToken = startPageTokenResp.data.startPageToken;
		console.log('Start page token:', changesPageToken);

		// Expire channel in 7 days
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		// 3) Watch for folder-level changes
		await drive.changes.watch({
			pageToken: changesPageToken,
			requestBody: {
				id: `watch-changes-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		console.log(
			'Monitoring folder changes. Expires at:',
			new Date(expiration).toLocaleString()
		);
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
 * Google push notification handler endpoint.
 * Google will POST notifications here when a file or folder changes.
 */
export async function handleNotification(req, res) {
	const io = req.app.get('io');
	const resourceUri = req.headers['x-goog-resource-uri'] || '';
	console.log('Push notification resourceUri:', resourceUri);

	try {
		if (resourceUri.includes('/files/')) {
			// Single-file notification
			await handleSingleFileNotification(resourceUri, io);
		} else if (resourceUri.includes('/changes')) {
			// Folder-level changes
			await handleChangesNotification(io);
		}
	} catch (err) {
		console.error('Error in handleNotification:', err);
	}

	return res.status(200).send('Notification received');
}

/**
 * Endpoint to renew the file watch channel before expiration.
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

		// Renew channel: new expiration in 7 days
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

		// Update mapping if necessary
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

/**
 * Stops monitoring for a specific file by calling `drive.channels.stop()`.
 * Expects { fileId } in req.body.
 */
export async function stopFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) {
			return res.status(400).send('Missing fileId');
		}

		// Validate user
		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		// Retrieve channel info
		const channelInfo = channelMap[fileId];
		if (!channelInfo) {
			return res.status(404).send('No active channel found for this file');
		}
		const { resourceId, channelId } = channelInfo;

		// Retrieve tokens & create OAuth client
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

		// Terminate the watch channel
		await drive.channels.stop({
			requestBody: {
				id: channelId,
				resourceId: resourceId,
			},
		});

		// Clean up in-memory references so we no longer track this file
		delete channelMap[fileId];
		delete fileModificationTimes[fileId];
		delete fileUserMapping[fileId];

		return res.status(200).json({
			message: `Stopped monitoring for file ${fileId}`,
		});
	} catch (error) {
		console.error('Error stopping file monitoring:', error);
		return res.status(500).send('Error stopping file monitoring');
	}
}

/* -------------------------------
   Internal Helper Functions
---------------------------------*/

/**
 * Handles a single-file change notification from Google Drive.
 * Only re-fetch if the file's `modifiedTime` changed.
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	// Look up the user ID from our in-memory map
	const userId = fileUserMapping[fileId];
	if (!userId) {
		console.error(`No user mapping found for fileId: ${fileId}`);
		return;
	}
	if (!isValidObjectId(userId)) {
		console.error(`Invalid user ID: ${userId}`);
		return;
	}

	// Get tokens & create OAuth client
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

		// Only fetch & emit if `modifiedTime` changed
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
			`Error handling file notification for fileId ${fileId}:`,
			err.response?.data || err.message
		);
	}
}

/**
 * Handles folder-level change notifications via `drive.changes.list()`.
 */
async function handleChangesNotification(io) {
	if (!monitoredFolderId || !changesPageToken) {
		console.log('No folder monitored or missing pageToken');
		return;
	}

	// Identify the user who owns this folder
	const userId = folderUserMapping[monitoredFolderId];
	if (!userId) {
		console.error(`No user mapping found for folderId: ${monitoredFolderId}`);
		return;
	}
	if (!isValidObjectId(userId)) {
		console.error(`Invalid user ID: ${userId}`);
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

				// If this file is in the monitored folder, check if we should re-fetch
				if (parents.includes(monitoredFolderId)) {
					const prevModTime = fileModificationTimes[fileId] || null;
					if (!prevModTime || prevModTime !== currentModifiedTime) {
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

		// Update pageToken for next time
		if (changesResp.data.newStartPageToken) {
			changesPageToken = changesResp.data.newStartPageToken;
		} else if (changesResp.data.nextPageToken) {
			changesPageToken = changesResp.data.nextPageToken;
		}
	} catch (err) {
		console.error(
			'Error processing folder changes:',
			err.response?.data || err.message
		);
	}
}

/**
 * Retrieves all files in a folder, initializes their modification times,
 * and immediately fetches & emits their content.
 */
async function retrieveAllFilesInFolder(folderId, drive, oauth2Client) {
	console.log('Retrieving all files in folder:', folderId);
	const io = null; // If you want immediate real-time broadcast, pass the real 'io'
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
			// Immediately fetch & emit content
			await fetchAndEmitFileContent(
				f.id,
				oauth2Client,
				io,
				false, // or true if you want global emission
				f.name || 'cloud_file'
			);
		}
		nextPageToken = resp.data.nextPageToken;
	} while (nextPageToken);
}

/**
 * Fetches and emits file content via Socket.io.
 * Handles Google Docs, CSV, XLSX, Google Sheets, etc.
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
		const mimeType = meta.data.mimeType;
		let fileContent = '';

		// 1) Google Docs => convert to plain text
		if (mimeType === 'application/vnd.google-apps.document') {
			const docs = google.docs({ version: 'v1', auth: oauth2Client });
			const docResp = await docs.documents.get({ documentId: fileId });
			fileContent = extractPlainText(docResp.data);

			// 2) CSV => read text directly
		} else if (mimeType === 'text/csv') {
			const csvResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');

			// 3) XLSX => parse with XLSX library
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

			// 4) Google Sheets => export as CSV
		} else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
			const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
			const spreadsheet = await sheets.spreadsheets.get({
				spreadsheetId: fileId,
				fields: 'sheets(properties(title,sheetId))',
			});
			const sheetTitles = (spreadsheet.data.sheets || []).map(
				(s) => s.properties.title
			);
			let allSheetsContent = '';
			for (const title of sheetTitles) {
				try {
					// We export the entire spreadsheet as CSV
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
				}
			}
			fileContent = allSheetsContent.trim();

			// 5) Folders => skip
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			return; // do nothing

			// 6) Unsupported file type => just mention it
		} else {
			fileContent = `Unsupported or unhandled file type: ${mimeType}`;
		}

		// Clean up some noise like "Sheet:..." lines if desired
		fileContent = removeSheetHeaders(fileContent);

		// Increment update counter (just for demonstration logging)
		updateCounter += 1;
		console.log(
			`Fetched content for file: ${actualFileName} (#${updateCounter})`
		);

		// Emit via Socket.io if we have content and an io instance
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
				// If your frontend clients have joined a room == fileId
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
 * Removes lines like `--- Sheet: SomeSheet ---` from the text,
 * if you want to strip out those headings from CSV merges.
 */
function removeSheetHeaders(text) {
	return text.replace(/^--- Sheet: .*? ---\r?\n?/gm, '').trim();
}
