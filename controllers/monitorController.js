import { google } from 'googleapis';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { getTokens, saveTokens } from '../tokenStore.js'; // Adjust path based on your project structure

// In-memory state (consider using a database like MongoDB or Redis in production)
const fileModificationTimes = {}; // key: fileId => last known modifiedTime
const fileUserMapping = {}; // key: fileId => userId
const channelMap = {}; // key: fileId => { channelId, resourceId }
let monitoredFolderId = null; // Tracks the currently monitored folder (single folder example)
const folderUserMapping = {}; // key: folderId => userId
let changesPageToken = null; // For tracking changes in drive.changes.watch
const folderChannelMap = {}; // key: folderId => { channelId, resourceId }

// Helper to validate MongoDB ObjectId
function isValidObjectId(id) {
	return mongoose.Types.ObjectId.isValid(id);
}

// Helper to create OAuth2 client
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

// Helper to extract user ID from request (adjust based on your authentication middleware)
function getUserId(req) {
	return req.user ? req.user.id : req.body.userId || req.query.userId;
}

/**
 * Sets up monitoring for a single file in Google Drive.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function setupFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) return res.status(400).send('Missing fileId');

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId))
			return res.status(400).send('Invalid user ID');
		fileUserMapping[fileId] = userId;

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token)
			return res
				.status(401)
				.send('No stored access token. Please log in first.');

		const { access_token, refresh_token, expiry_date } = tokens;
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		const { resourceId, id: channelId } = watchResponse.data || {};
		if (resourceId && channelId) {
			channelMap[fileId] = { resourceId, channelId };
		} else {
			console.warn(
				'Watch response missing resourceId or channelId:',
				watchResponse.data
			);
		}

		const fileMeta = await drive.files.get({
			fileId,
			fields: 'modifiedTime, name',
		});
		const currentModifiedTime =
			fileMeta.data.modifiedTime || new Date().toISOString();
		const fileNameFromMeta = fileMeta.data.name || 'cloud_file';
		fileModificationTimes[fileId] = currentModifiedTime;

		const io = req.app.get('io');
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
		console.error('Error setting up file monitoring:', error);
		return res.status(500).send('Error setting up file watch');
	}
}

/**
 * Sets up monitoring for a folder in Google Drive.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) return res.status(400).send('Missing folderId');

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId))
			return res.status(400).send('Invalid user ID');
		monitoredFolderId = folderId;
		folderUserMapping[folderId] = userId;

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token)
			return res
				.status(401)
				.send('No stored access token. Please log in first.');

		const { access_token, refresh_token, expiry_date } = tokens;
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Fetch initial folder contents
		await retrieveAllFilesInFolder(
			folderId,
			drive,
			oauth2Client,
			req.app.get('io')
		);

		// Set up change monitoring
		const startPageTokenResp = await drive.changes.getStartPageToken();
		changesPageToken = startPageTokenResp.data.startPageToken;

		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;
		const watchResponse = await drive.changes.watch({
			pageToken: changesPageToken,
			requestBody: {
				id: `watch-changes-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		const { resourceId, id: channelId } = watchResponse.data || {};
		if (resourceId && channelId) {
			folderChannelMap[folderId] = { resourceId, channelId };
		}

		return res.status(200).json({
			message: 'Monitoring started for folder',
			folderId,
			channelExpiration: expiration,
			expirationDate: new Date(expiration).toLocaleString(),
		});
	} catch (error) {
		console.error('Error setting up folder monitoring:', error);
		return res.status(500).send('Error setting up folder watch');
	}
}

/**
 * Handles incoming notifications from Google Drive for file or folder changes.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function handleNotification(req, res) {
	const io = req.app.get('io');
	const resourceUri = req.headers['x-goog-resource-uri'] || '';

	try {
		if (resourceUri.includes('/files/')) {
			await handleSingleFileNotification(resourceUri, io);
		} else if (resourceUri.includes('/changes')) {
			await handleChangesNotification(io);
		}
		return res.status(200).send('Notification received');
	} catch (error) {
		console.error('Error in handleNotification:', error);
		return res.status(500).send('Error processing notification');
	}
}

/**
 * Renews the monitoring channel for a single file.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function renewFileChannel(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) return res.status(400).send('Missing fileId');

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId))
			return res.status(400).send('Invalid user ID');

		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token)
			return res.status(401).send('No stored access token.');

		const { access_token, refresh_token, expiry_date } = tokens;
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`,
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
				expiration,
			},
		});

		const { resourceId, id: channelId } = watchResponse.data || {};
		if (resourceId && channelId) {
			channelMap[fileId] = { resourceId, channelId };
		}

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
 * Stops monitoring for a single file.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function stopFileMonitoring(req, res) {
	try {
		const { fileId } = req.body;
		if (!fileId) return res.status(400).send('Missing fileId');

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId))
			return res.status(400).send('Invalid user ID');

		const channelInfo = channelMap[fileId];
		if (!channelInfo)
			return res.status(404).send('No active channel found for this file');

		const { resourceId, channelId } = channelInfo;
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token)
			return res.status(401).send('No stored access token.');

		const { access_token, refresh_token, expiry_date } = tokens;
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		await drive.channels.stop({
			requestBody: {
				id: channelId,
				resourceId,
			},
		});

		delete channelMap[fileId];
		delete fileModificationTimes[fileId];
		delete fileUserMapping[fileId];

		return res
			.status(200)
			.json({ message: `Stopped monitoring for file ${fileId}` });
	} catch (error) {
		console.error('Error stopping file monitoring:', error);
		return res.status(500).send('Error stopping file monitoring');
	}
}

/**
 * Stops monitoring for a folder.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function stopFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) return res.status(400).send('Missing folderId');

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId))
			return res.status(400).send('Invalid user ID');

		const channelInfo = folderChannelMap[folderId];
		if (!channelInfo)
			return res.status(404).send('No active channel found for this folder');

		const { resourceId, channelId } = channelInfo;
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token)
			return res.status(401).send('No stored access token.');

		const { access_token, refresh_token, expiry_date } = tokens;
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });
		await drive.channels.stop({
			requestBody: {
				id: channelId,
				resourceId,
			},
		});

		delete folderChannelMap[folderId];
		delete folderUserMapping[folderId];
		if (monitoredFolderId === folderId) {
			monitoredFolderId = null;
			changesPageToken = null;
		}

		return res
			.status(200)
			.json({ message: `Stopped monitoring folder ${folderId}` });
	} catch (error) {
		console.error('Error stopping folder monitoring:', error);
		return res.status(500).send('Error stopping folder monitoring');
	}
}

// **Internal Helper Functions**

/**
 * Handles notifications for single-file changes.
 * @param {string} resourceUri - The resource URI from the notification header
 * @param {Object} io - Socket.io instance
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	const userId = fileUserMapping[fileId];
	if (!userId || !isValidObjectId(userId)) return;

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

		// Only process if the file has actually changed
		if (fileModificationTimes[fileId] !== currentModifiedTime) {
			fileModificationTimes[fileId] = currentModifiedTime;
			await fetchAndEmitFileContent(
				fileId,
				oauth2Client,
				io,
				false,
				fileNameFromMeta
			);
		}
	} catch (err) {
		console.error(
			`Error handling file notification for fileId ${fileId}:`,
			err
		);
	}
}

/**
 * Handles notifications for folder changes using drive.changes.list().
 * @param {Object} io - Socket.io instance
 */
async function handleChangesNotification(io) {
	if (!monitoredFolderId || !changesPageToken) return;

	const userId = folderUserMapping[monitoredFolderId];
	if (!userId || !isValidObjectId(userId)) return;

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
				const fileNameFromMeta = fileMeta.data.name || 'cloud_file';

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
					}
				}
			} catch (fileErr) {
				console.error(`Error fetching metadata for fileId ${fileId}:`, fileErr);
			}
		}

		// Update page token for tracking subsequent changes
		if (changesResp.data.newStartPageToken) {
			changesPageToken = changesResp.data.newStartPageToken;
		} else if (changesResp.data.nextPageToken) {
			changesPageToken = changesResp.data.nextPageToken;
		}
	} catch (err) {
		console.error('Error processing folder changes:', err);
	}
}

/**
 * Retrieves all files in a folder and emits their content.
 * @param {string} folderId - Google Drive folder ID
 * @param {Object} drive - Google Drive API instance
 * @param {Object} oauth2Client - OAuth2 client
 * @param {Object} io - Socket.io instance
 */
async function retrieveAllFilesInFolder(folderId, drive, oauth2Client, io) {
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
				io,
				true,
				f.name || 'cloud_file'
			);
		}
		nextPageToken = resp.data.nextPageToken;
	} while (nextPageToken);
}

/**
 * Fetches file content and emits it via Socket.io.
 * @param {string} fileId - Google Drive file ID
 * @param {Object} oauth2Client - OAuth2 client
 * @param {Object} io - Socket.io instance
 * @param {boolean} emitGlobally - Whether to emit to all clients or a specific room
 * @param {string} actualFileName - Name of the file
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
		const meta = await drive.files.get({ fileId, fields: 'mimeType' });
		const mimeType = meta.data.mimeType;
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
			fileContent = workbook.SheetNames.map((sheetName) =>
				XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName])
			).join('\n\n');
		} else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
			const csvResp = await drive.files.export(
				{ fileId, mimeType: 'text/csv' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			return; // Skip folders
		} else {
			fileContent = `Unsupported or unhandled file type: ${mimeType}`;
		}

		// Clean up content
		fileContent = removeSheetHeaders(fileContent);

		// Emit event via Socket.io
		const eventPayload = {
			fileId,
			fileName: actualFileName,
			message: `File "${actualFileName}" updated.`,
			fullText: fileContent,
		};
		if (emitGlobally) {
			io.emit('file-updated', eventPayload);
		} else {
			io.to(fileId).emit('file-updated', eventPayload);
		}
	} catch (err) {
		console.error('Error fetching file content:', err);
	}
}

/**
 * Extracts plain text from a Google Docs document.
 * @param {Object} doc - Google Docs document object
 * @returns {string} Plain text content
 */
function extractPlainText(doc) {
	if (!doc.body || !doc.body.content) return '';
	let text = '';
	for (const element of doc.body.content) {
		if (element.paragraph?.elements) {
			for (const pe of element.paragraph.elements) {
				if (pe.textRun?.content) text += pe.textRun.content;
			}
			text += '\n';
		}
	}
	return text.trim();
}

/**
 * Removes sheet headers from content (e.g., from multi-sheet XLSX files).
 * @param {string} text - Original content
 * @returns {string} Content without sheet headers
 */
function removeSheetHeaders(text) {
	return text.replace(/^--- Sheet: .*? ---\r?\n?/gm, '').trim();
}
