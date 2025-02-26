// controllers/monitorController.js

import { google } from 'googleapis';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import { getTokens, saveTokens } from '../tokenStore.js'; // or wherever you store tokens
import { mergeDashboardData } from '../utils/dashboardUtils.js';

/**
 * ================
 * In-memory state
 * ================
 */
let updateCounter = 0;

// For single-file tracking
const fileModificationTimes = {}; // key: fileId   => last known modifiedTime
const fileUserMapping = {}; // key: fileId   => userId
const channelMap = {}; // key: fileId   => { channelId, resourceId }

// For folder tracking
let monitoredFolderId = null; // single example of one monitored folder
let folderUserMapping = {}; // key: folderId => userId
let changesPageToken = null; // tracks the "startPageToken" for Drive changes
let folderChannelMap = {};
// A helper to validate userId as a valid MongoDB _id
function isValidObjectId(id) {
	return mongoose.Types.ObjectId.isValid(id);
}

// Utility: create OAuth client
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

// Utility: get user ID from request
function getUserId(req) {
	// Adjust this depending on your auth strategy
	return req.user ? req.user.id : req.body.userId || req.query.userId;
}

/* ===========================================================================================
   1) Setup single-file monitoring
   ========================================================================================= */
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

		// Get tokens
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// Create OAuth2 client
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

		// Watch the file
		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`, // Unique channel ID
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`, // your webhook
				expiration,
			},
		});

		// Grab resource & channel IDs so we can stop later
		const { resourceId, id: channelId } = watchResponse.data || {};
		if (resourceId && channelId) {
			channelMap[fileId] = { resourceId, channelId };
		} else {
			console.warn(
				'Watch response missing resourceId or channelId:',
				watchResponse.data
			);
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

		// Immediately fetch & emit the current file content
		const io = req.app.get('io'); // Socket.io reference
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

/* ===========================================================================================
   2) Setup folder monitoring
   ========================================================================================= */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}

		const userId = getUserId(req);
		if (!userId) return res.status(401).send('User not authenticated');
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		monitoredFolderId = folderId;
		folderUserMapping[folderId] = userId;

		// Get tokens
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res
				.status(401)
				.send('No stored access token. Please log in first.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// Create OAuth2 client
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Immediately retrieve & emit all files in the folder
		await retrieveAllFilesInFolder(
			folderId,
			drive,
			oauth2Client,
			req.app.get('io')
		);

		// Get a start page token for drive changes
		const startPageTokenResp = await drive.changes.getStartPageToken();
		changesPageToken = startPageTokenResp.data.startPageToken;
		console.log('Start page token:', changesPageToken);

		// Expire channel in 7 days
		const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;

		// Watch for folder changes via drive.changes.watch
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
		console.error('Error setting up folder monitoring:', error);
		return res.status(500).send('Error setting up folder watch');
	}
}

/* ===========================================================================================
   3) Handle push notifications (both single-file and folder changes)
   ========================================================================================= */
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

/* ===========================================================================================
   4) Renew single-file channel
   ========================================================================================= */
export async function renewFileChannel(req, res) {
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

		// Retrieve tokens
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res.status(401).send('No stored access token.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// OAuth
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Renew channel for next 7 days
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

/* ===========================================================================================
   5) Stop single-file monitoring
   ========================================================================================= */
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

		// Retrieve tokens
		const tokens = await getTokens(userId);
		if (!tokens || !tokens.access_token) {
			return res.status(401).send('No stored access token.');
		}
		const { access_token, refresh_token, expiry_date } = tokens;

		// OAuth
		const oauth2Client = createOAuthClient(
			access_token,
			refresh_token,
			expiry_date
		);
		await oauth2Client.getAccessToken();
		await saveTokens(userId, oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Stop channel
		await drive.channels.stop({
			requestBody: {
				id: channelId,
				resourceId,
			},
		});

		// Clean up memory references
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

/* ===========================================================================================
   Internal Helpers
   ========================================================================================= */

/**
 * Handle single-file change notifications:
 * - Compare modifiedTime, fetch content if changed, emit via Socket.io.
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	const userId = fileUserMapping[fileId];
	if (!userId) {
		console.error(`No user mapping found for fileId: ${fileId}`);
		return;
	}
	if (!isValidObjectId(userId)) {
		console.error(`Invalid user ID: ${userId}`);
		return;
	}

	// Get tokens
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
		// Check if modifiedTime changed
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
			`Error handling file notification for fileId ${fileId}:`,
			err.response?.data || err.message
		);
	}
}

/**
 * Handles notifications from Google Drive about changes in monitored folders.
 * Processes the changes and updates the dashboard accordingly.
 * @param {Object} req - Express request object containing the notification details
 * @param {Object} res - Express response object
 * @param {Object} io - Socket.IO instance for real-time updates
 */
async function handleChangesNotification(req, res, io) {
	try {
		const channelId = req.headers['x-goog-channel-id'];
		if (!channelId) {
			console.error('Missing channel ID in notification');
			return res.status(400).send('Missing channel ID');
		}

		// Find user monitoring record
		const userMonitoring = await UserMonitoring.findOne({ channelId });
		if (!userMonitoring) {
			console.error('UserMonitoring not found for channel ID:', channelId);
			return res.status(404).send('UserMonitoring not found');
		}

		const userId = userMonitoring.userId;
		const monitoredFolders = userMonitoring.monitoredFolders;
		const tokens = await getTokens(userId);
		const authClient = createOAuthClient(
			tokens.access_token,
			tokens.refresh_token,
			tokens.expiry_date
		);
		const drive = google.drive({ version: 'v3', auth: authClient });

		for (const folder of monitoredFolders) {
			const changesResp = await drive.changes.list({
				pageToken: folder.changesPageToken,
				spaces: 'drive',
				fields:
					'newStartPageToken, nextPageToken, changes(fileId, removed, file)',
			});

			for (const change of changesResp.data.changes) {
				const file = change.file;
				if (file && file.parents && file.parents.includes(folder.folderId)) {
					const dashboard = await Dashboard.findOne({ userId });
					if (!dashboard) continue;

					if (change.removed) {
						dashboard.dashboardData = removeFileFromDashboard(
							dashboard.dashboardData,
							file.name
						);
						dashboard.files = dashboard.files.filter(
							(f) => f.fileId !== file.id
						);
					} else {
						const fileContent = await fetchAndEmitFileContent(
							file.id,
							authClient
						);
						const dashboardData = await processFileContent(
							fileContent,
							file.name
						);
						dashboard.dashboardData = removeFileFromDashboard(
							dashboard.dashboardData,
							file.name
						);
						dashboard.dashboardData = mergeDashboardData(
							dashboard.dashboardData,
							dashboardData
						);
						const existingFile = dashboard.files.find(
							(f) => f.fileId === file.id
						);
						if (existingFile) {
							existingFile.content = dashboardData;
							existingFile.lastUpdate = new Date(file.modifiedTime);
						} else {
							dashboard.files.push({
								fileId: file.id,
								filename: file.name,
								content: dashboardData,
								lastUpdate: new Date(file.modifiedTime),
								source: 'google',
								monitoring: { status: 'active', folderId: folder.folderId },
							});
						}
					}
					await dashboard.save();
					io.to(userId).emit('dashboard-updated', {
						dashboardId: dashboard._id,
						dashboard,
					});
				}
			}

			// Update the changes page token
			if (changesResp.data.newStartPageToken) {
				folder.changesPageToken = changesResp.data.newStartPageToken;
			} else if (changesResp.data.nextPageToken) {
				folder.changesPageToken = changesResp.data.nextPageToken;
			}
		}

		await userMonitoring.save();
		return res.status(200).send('Notification processed');
	} catch (error) {
		console.error('Error handling changes notification:', error);
		return res.status(500).send('Error processing notification');
	}
}

/**
 * Fetch all files in a folder, parse them, emit them one by one.
 */
async function retrieveAllFilesInFolder(folderId, drive, oauth2Client, io) {
	console.log('Retrieving all files in folder:', folderId);

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
 * Fetch and emit file content (handles Google Docs, CSV, XLSX, Sheets).
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

		// 1) Google Docs
		if (mimeType === 'application/vnd.google-apps.document') {
			const docs = google.docs({ version: 'v1', auth: oauth2Client });
			const docResp = await docs.documents.get({ documentId: fileId });
			fileContent = extractPlainText(docResp.data);

			// 2) CSV
		} else if (mimeType === 'text/csv') {
			const csvResp = await drive.files.get(
				{ fileId, alt: 'media' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');

			// 3) XLSX
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

			// 4) Google Sheets
		} else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
			// We'll export entire spreadsheet as CSV
			const csvResp = await drive.files.export(
				{ fileId, mimeType: 'text/csv' },
				{ responseType: 'arraybuffer' }
			);
			fileContent = Buffer.from(csvResp.data).toString('utf8');

			// 5) Folder => skip
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			return; // do nothing

			// 6) Unsupported => just note it
		} else {
			fileContent = `Unsupported or unhandled file type: ${mimeType}`;
		}

		// Clean up any sheet headers if you wish
		fileContent = removeSheetHeaders(fileContent);

		// Increment update counter
		updateCounter += 1;
		console.log(
			`Fetched content for file: ${actualFileName} (#${updateCounter})`
		);

		// Emit if content is available
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
				// If your frontend clients have joined a room matching fileId
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
 * Extract plain text from a Google Doc.
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
 * Stops monitoring for a specific folder by calling `drive.channels.stop()`.
 * Expects { folderId } in req.body.
 */
/**
 * Stops monitoring for a specific folder by calling `drive.channels.stop()`.
 * Expects { folderId } in req.body.
 */
export async function stopFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}

		// Validate user (adjust depending on your auth strategy)
		const userId = getUserId(req);
		if (!userId) {
			return res.status(401).send('User not authenticated');
		}
		if (!isValidObjectId(userId)) {
			return res.status(400).send('Invalid user ID');
		}

		// Retrieve folder channel info
		const channelInfo = folderChannelMap[folderId];
		if (!channelInfo) {
			return res.status(404).send('No active channel found for this folder');
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

		// Terminate the watch channel using the channel ID + resource ID
		await drive.channels.stop({
			requestBody: {
				id: channelId,
				resourceId,
			},
		});

		// Clean up references so we no longer track this folder
		delete folderChannelMap[folderId];
		delete folderUserMapping[folderId];

		// If you're only monitoring ONE folder at a time, clear these:
		if (monitoredFolderId === folderId) {
			monitoredFolderId = null;
			changesPageToken = null;
		}

		return res.status(200).json({
			message: `Stopped monitoring folder ${folderId}`,
		});
	} catch (error) {
		console.error('Error stopping folder monitoring:', error);
		return res.status(500).send('Error stopping folder monitoring');
	}
}

/**
 * Remove lines like "--- Sheet: Something ---" if desired.
 */
function removeSheetHeaders(text) {
	return text.replace(/^--- Sheet: .*? ---\r?\n?/gm, '').trim();
}
