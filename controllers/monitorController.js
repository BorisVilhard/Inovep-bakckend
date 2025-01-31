// controllers/monitorController.js

import { google } from 'googleapis';
import XLSX from 'xlsx';
import { getTokens, saveTokens } from '../tokenStore.js';

/**
 * In-memory or persistent state to track modification times, page tokens, etc.
 * For simplicity, all in memory here.
 */
let updateCounter = 0;
let monitoredFolderId = null;
let changesPageToken = null;
const fileModificationTimes = {};

/**
 * Sets up monitoring for a single file in Drive.
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
		await oauth2Client.getAccessToken();
		saveTokens(oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// Tell Google to send push notifications for this file
		const watchResponse = await drive.files.watch({
			fileId,
			requestBody: {
				id: `watch-${fileId}-${Date.now()}`, // Unique channel ID
				type: 'web_hook',
				address: `${process.env.BACKEND_URL}/api/monitor/notifications`,
			},
		});

		console.log('Single-file watch response:', watchResponse.data);

		// Get the file's current modification time and name
		const fileMeta = await drive.files.get({
			fileId,
			fields: 'modifiedTime, name',
		});

		fileModificationTimes[fileId] = fileMeta.data.modifiedTime;

		return res.status(200).send('Monitoring started for file');
	} catch (error) {
		console.error('Error setting up file watch:', error);
		return res.status(500).send('Error setting up file watch');
	}
}

/**
 * Sets up monitoring for a folder in Drive.
 */
export async function setupFolderMonitoring(req, res) {
	try {
		const { folderId } = req.body;
		if (!folderId) {
			return res.status(400).send('Missing folderId');
		}
		monitoredFolderId = folderId;

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
		await oauth2Client.getAccessToken();
		saveTokens(oauth2Client.credentials);

		const drive = google.drive({ version: 'v3', auth: oauth2Client });

		// 1) Retrieve & parse all existing files in the folder
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
			// Means a single-file watch triggered
			await handleSingleFileNotification(resourceUri, io);
		} else if (resourceUri.includes('/changes')) {
			// Means a folder-level watch triggered
			await handleChangesNotification(io);
		}
	} catch (err) {
		console.error('Error in handleNotification:', err);
	}

	return res.status(200).send('Notification received');
}

/* -------------------------------------
 *        Helper Functions
 * ------------------------------------- */

/**
 * For single-file notifications
 */
async function handleSingleFileNotification(resourceUri, io) {
	const match = resourceUri.match(/files\/([a-zA-Z0-9_-]+)/);
	const fileId = match ? match[1] : null;
	if (!fileId) return;

	const { access_token, refresh_token, expiry_date } = getTokens();
	if (!access_token) return;

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
		const fileNameFromMeta = fileMeta.data.name || 'cloud_file'; // fallback

		// If the mod time changed, fetch new content & emit
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
 * For folder-level notifications
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
				console.log(`File removed: ${fileId}`);
				delete fileModificationTimes[fileId];
				continue;
			}

			// Check if file is in the monitored folder
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
 * Retrieves all files in a folder & initializes their modification times.
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
 * Fetches & emits file content from Drive (Docs, CSV, XLSX, Sheets, etc.),
 * including the real file name passed in as `actualFileName`.
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
			fields: 'mimeType', // We don't need name again because we already have actualFileName
		});
		const { mimeType } = meta.data;

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

			// 5) Skip folders
		} else if (mimeType === 'application/vnd.google-apps.folder') {
			return;

			// 6) Not handled
		} else {
			fileContent = `Unsupported or unhandled file type: ${mimeType}`;
		}

		// Optionally remove lines like `--- Sheet: ... ---`
		fileContent = removeSheetHeaders(fileContent);

		// Emit via socket
		updateCounter += 1;
		console.log(
			`Fetched content for file: ${actualFileName} (#${updateCounter})`
		);

		if (io && fileContent) {
			const eventPayload = {
				fileId,
				fileName: actualFileName, // pass the real name to the frontend
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
 * Extract plain text from a Google Doc
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
 * Remove lines like `--- Sheet: SheetName ---` from the text if desired.
 */
function removeSheetHeaders(text) {
	return text.replace(/^--- Sheet: .*? ---\r?\n?/gm, '').trim();
}

/**
 * Create an OAuth2 client
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
