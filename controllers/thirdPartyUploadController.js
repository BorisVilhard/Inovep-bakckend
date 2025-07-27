import axios from 'axios';
import * as url from 'url';
import crypto from 'crypto';
import jwksRsa from 'jwks-rsa';
import jwt from 'jsonwebtoken';
// QuickBooks Configuration
const QUICKBOOKS_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
const QUICKBOOKS_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
const BACKEND_BASE_URL =
	process.env.BACKEND_BASE_URL || 'http://localhost:3500';
const REDIRECT_URI = `${BACKEND_BASE_URL}/upload/quickbooks/callback`;
const OAUTH_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_ENDPOINT =
	'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE_URL =
	process.env.QUICKBOOKS_ENVIRONMENT === 'production'
		? 'https://quickbooks.api.intuit.com'
		: 'https://sandbox-quickbooks.api.intuit.com';

// Pohoda Configuration
const POHODA_TOKEN_ENDPOINT = 'https://ucet.pohoda.cz/connect/token';
const POHODA_API_BASE_URL = 'https://api.mpohoda.sk/v1';
const POHODA_SCOPE = 'Mph.OpenApi.Access.Sk';

// In-Memory Token Store (Production: Use secure database)
const tokenStore = {};

/**
 * Refreshes OAuth2 token when expired
 */
const refreshToken = async (userId) => {
	console.log(`Attempting to refresh token for user ${userId}...`);
	const { refresh_token } = tokenStore[userId];
	const authHeader = `Basic ${Buffer.from(
		`${QUICKBOOKS_CLIENT_ID}:${QUICKBOOKS_CLIENT_SECRET}`
	).toString('base64')}`;

	try {
		const response = await axios.post(
			TOKEN_ENDPOINT,
			new URLSearchParams({ grant_type: 'refresh_token', refresh_token }),
			{
				headers: {
					Authorization: authHeader,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			}
		);

		tokenStore[userId].access_token = response.data.access_token;
		tokenStore[userId].refresh_token = response.data.refresh_token;
		tokenStore[userId].expires_at =
			Date.now() + response.data.expires_in * 1000;
		console.log('Token successfully refreshed!');
		return tokenStore[userId].access_token;
	} catch (error) {
		console.error(
			'Failed to refresh token:',
			error.response ? error.response.data : error.message
		);
		delete tokenStore[userId];
		throw new Error('Could not refresh token. User must re-authenticate.');
	}
};

/**
 * Makes authenticated API calls with token refresh handling
 */
const makeApiCall = async (userId, config) => {
	if (!tokenStore[userId]) {
		throw new Error(
			'User not authenticated. Please connect to QuickBooks first.'
		);
	}

	if (Date.now() >= tokenStore[userId].expires_at - 5 * 60 * 1000) {
		await refreshToken(userId);
	}

	const { access_token } = tokenStore[userId];
	config.headers = {
		...config.headers,
		Authorization: `Bearer ${access_token}`,
		Accept: 'application/json',
	};

	try {
		const response = await axios(config);
		return response.data;
	} catch (error) {
		if (error.response && error.response.status === 401) {
			console.log('API call failed with 401, attempting a final refresh...');
			await refreshToken(userId);
			const new_access_token = tokenStore[userId].access_token;
			config.headers['Authorization'] = `Bearer ${new_access_token}`;
			const retryResponse = await axios(config);
			return retryResponse.data;
		}
		throw error;
	}
};

/**
 * Initiates QuickBooks OAuth2 flow
 * @route GET /upload/quickbooks/connect
 */
const quickbooksConnect = (req, res) => {
	const userId = req.user?.id || 'user_123';
	const state = crypto.randomBytes(16).toString('hex');
	tokenStore[userId] = { ...tokenStore[userId], csrfState: state };

	const authUrl = url.format({
		protocol: 'https',
		hostname: 'appcenter.intuit.com',
		pathname: '/connect/oauth2',
		query: {
			client_id: QUICKBOOKS_CLIENT_ID,
			response_type: 'code',
			scope: 'com.intuit.quickbooks.accounting openid',
			redirect_uri: REDIRECT_URI,
			state: state,
		},
	});

	console.log('Redirecting user to:', authUrl);
	res.redirect(authUrl);
};

const quickbooksCallback = async (req, res) => {
	const { code, state, realmId } = req.query;
	const userId = req.user?.id || 'user_123';

	if (state !== tokenStore[userId]?.csrfState) {
		return res.status(400).send('CSRF Detected: Invalid state parameter.');
	}

	const authHeader = `Basic ${Buffer.from(
		`${QUICKBOOKS_CLIENT_ID}:${QUICKBOOKS_CLIENT_SECRET}`
	).toString('base64')}`;

	try {
		const response = await axios.post(
			TOKEN_ENDPOINT,
			new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT_URI,
			}),
			{
				headers: {
					Authorization: authHeader,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			}
		);

		const id_token = response.data.id_token;
		if (!id_token) {
			throw new Error('No ID token received');
		}

		const jwksClient = jwksRsa({
			cache: true,
			rateLimit: true,
			jwksRequestsPerMinute: 5,
			jwksUri: 'https://oauth.platform.intuit.com/op/v1/jwks',
		});

		const decodedToken = jwt.decode(id_token, { complete: true });
		const kid = decodedToken.header.kid;

		const key = await new Promise((resolve, reject) => {
			jwksClient.getSigningKey(kid, (err, key) => {
				if (err) reject(err);
				else resolve(key.publicKey || key.rsaPublicKey);
			});
		});

		const verified = jwt.verify(id_token, key, {
			algorithms: ['RS256'],
			audience: QUICKBOOKS_CLIENT_ID,
			issuer: 'https://oauth.platform.intuit.com/op/v1',
		});

		if (!verified) {
			throw new Error('ID token validation failed');
		}

		console.log('ID token validated successfully:', verified);

		const tokens = {
			access_token: response.data.access_token,
			refresh_token: response.data.refresh_token,
			realmId: realmId,
			expires_at: Date.now() + response.data.expires_in * 1000,
			refresh_token_expires_at:
				Date.now() + response.data.x_refresh_token_expires_in * 1000,
		};

		tokenStore[userId] = tokens;

		console.log('QuickBooks account connected successfully!');

		// Send script with postMessage instead of redirect
		res.send(`
			<html>
				<body>
					<script>
						if (window.opener) {
							window.opener.postMessage({
								source: 'quickbooks-callback',
								access_token: '${tokens.access_token}',
								refresh_token: '${tokens.refresh_token}',
								realmId: '${tokens.realmId}',
								expires_at: '${tokens.expires_at}'
							}, '*');
							window.close();
						} else {
							window.location.href = 'http://localhost:3000/';
						}
					</script>
					Authentication successful. Redirecting...
				</body>
			</html>
		`);
	} catch (error) {
		console.error(
			'Error exchanging authorization code or validating ID token:',
			error.response ? error.response.data : error.message
		);
		res.status(500).send('An error occurred while connecting to QuickBooks.');
	}
};

function slugify(text) {
	return text.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function restructureQuickbooksResponse(response) {
	const categories = [];

	// General function for reports (like ProfitAndLoss, CashFlow, etc.)
	const processReport = (reportData, catName, endDate) => {
		const data = [];

		function processRows(rows, group = null) {
			rows.forEach((row) => {
				let entry = null;

				if (row.type === 'Data') {
					const colData = row.ColData;
					if (colData && colData.length >= 2 && colData[0].value) {
						const id = colData[0].id || slugify(colData[0].value);
						const t = colData[0].value;
						const v = parseFloat(colData[1].value) || 0;
						entry = { i: id, d: [{ t, v, d: endDate }] };
						data.push(entry);
					}
				} else if (row.type === 'Section') {
					// Process Header if id present
					if (
						row.Header &&
						row.Header.ColData &&
						row.Header.ColData.length >= 2 &&
						row.Header.ColData[0].id
					) {
						const headerCol = row.Header.ColData;
						const id = headerCol[0].id;
						const t = headerCol[0].value;
						const v = parseFloat(headerCol[1].value) || 0;
						entry = { i: id, d: [{ t, v, d: endDate }] };
						data.push(entry);
					}

					// Recurse into sub rows
					if (row.Rows && row.Rows.Row) {
						processRows(row.Rows.Row, row.group);
					}

					// Process Summary
					if (
						row.Summary &&
						row.Summary.ColData &&
						row.Summary.ColData.length >= 2
					) {
						const sumCol = row.Summary.ColData;
						const sumT = sumCol[0].value;
						const sumV = parseFloat(sumCol[1].value) || 0;
						let sumI = row.group || slugify(sumT.replace(/^Total /, ''));
						if (!sumI) {
							sumI = slugify(sumT.replace(/^Total /, ''));
						}
						entry = { i: sumI, d: [{ t: sumT, v: sumV, d: endDate }] };
						data.push(entry);
					}
				}
			});
		}

		if (reportData.Rows && reportData.Rows.Row) {
			processRows(reportData.Rows.Row);
		}

		categories.push({
			cat: catName,
			data,
			comp: [],
			sum: [],
			ids: [],
		});
	};

	// General function for entities (like Bill, Invoice, etc.)
	const processEntity = (entityData, catName) => {
		if (entityData.QueryResponse && entityData.QueryResponse[catName]) {
			const items = entityData.QueryResponse[catName];
			const data = items.map((item) => {
				const i = item.Id;
				const t =
					item.VendorRef?.name ||
					item.CustomerRef?.name ||
					item.Name ||
					'Transaction';
				const v = item.TotalAmt || item.Balance || item.Amount || 0;
				const d =
					item.TxnDate ||
					item.Date ||
					item.CreateTime ||
					new Date().toISOString().split('T')[0];
				return { i, d: [{ t, v, d }] };
			});

			categories.push({
				cat: catName,
				data,
				comp: [],
				sum: [],
				ids: [],
			});
		}
	};

	// Process each response key
	Object.keys(response).forEach((key) => {
		const data = response[key];
		const endDate =
			data.Header?.EndPeriod || new Date().toISOString().split('T')[0];

		if (data.Header && data.Columns && data.Rows) {
			// It's a report
			processReport(data, key, endDate);
		} else if (data.QueryResponse) {
			// It's an entity query
			const entityName = Object.keys(data.QueryResponse)[0];
			processEntity(data, entityName);
		}
	});

	return categories;
}

/**
 * Fetches essential QuickBooks data for SaaS financial metrics
 * @route GET /upload/quickbooks/all-data
 */
const quickbooksAllData = async (req, res) => {
	const userId = req.user?.id || 'user_123';
	const { start_date, end_date } = req.query;

	// Validate date parameters
	if (!start_date || !end_date) {
		return res.status(400).json({
			error: 'start_date and end_date are required query parameters',
		});
	}

	// Validate date format (YYYY-MM-DD)
	const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
	if (!dateRegex.test(start_date) || !dateRegex.test(end_date)) {
		return res.status(400).json({
			error: 'start_date and end_date must be in YYYY-MM-DD format',
		});
	}

	// Validate date range (e.g., start_date <= end_date)
	const startDate = new Date(start_date);
	const endDate = new Date(end_date);
	if (startDate > endDate) {
		return res.status(400).json({
			error: 'start_date must be before or equal to end_date',
		});
	}

	// Update tokenStore if tokens provided in headers
	const access_token = req.headers['x-quickbooks-access-token'];
	if (access_token) {
		tokenStore[userId] = {
			access_token,
			refresh_token:
				req.headers['x-quickbooks-refresh-token'] ||
				tokenStore[userId]?.refresh_token,
			realmId:
				req.headers['x-quickbooks-realm-id'] || tokenStore[userId]?.realmId,
			expires_at:
				parseInt(req.headers['x-quickbooks-token-expires-at']) ||
				Date.now() + 3600 * 1000, // 1 hour
			refresh_token_expires_at:
				tokenStore[userId]?.refresh_token_expires_at ||
				Date.now() + 8640000 * 100, // 100 days
		};
	}

	// Check for valid token
	if (!tokenStore[userId]?.access_token || !tokenStore[userId]?.realmId) {
		return res.status(401).json({
			message: 'Not connected. Please connect to QuickBooks first.',
			connectUrl: '/api/quickbooks/connect',
		});
	}

	const { realmId } = tokenStore[userId];

	// Define optimized endpoints for SaaS metrics
	const endpoints = [
		{
			name: 'Bill',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Bill'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'BillPayment',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM BillPayment'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'Budget',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Budget'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'CustomerBalance',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/CustomerBalance?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'CustomerIncome',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/CustomerIncome?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'Deposit',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Deposit'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'Invoice',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Invoice'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'Item',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Item'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'Payment',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Payment'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'ProfitAndLoss',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/ProfitAndLoss?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'Purchase',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM Purchase'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'RecurringTransaction',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM RecurringTransaction'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'SalesByCustomer',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/CustomerSales?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'SalesByProduct',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/ItemSales?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'SalesReceipt',
			url: `${API_BASE_URL}/v3/company/${realmId}/query?query=${encodeURIComponent(
				'SELECT * FROM SalesReceipt'
			)}&minorversion=75`,
			isReport: false,
		},
		{
			name: 'TransactionList',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/TransactionList?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
		{
			name: 'CashFlow',
			url: `${API_BASE_URL}/v3/company/${realmId}/reports/CashFlow?start_date=${start_date}&end_date=${end_date}&minorversion=75`,
			isReport: true,
		},
	];

	try {
		const results = {};
		const promises = endpoints.map(async (endpoint) => {
			try {
				const data = await makeApiCall(userId, {
					method: 'GET',
					url: endpoint.url,
				});
				results[endpoint.name] = data;
			} catch (error) {
				results[endpoint.name] = {
					error: `Failed to fetch ${endpoint.name}: ${error.message}`,
				};
			}
		});

		await Promise.all(promises);
		const restructured = restructureQuickbooksResponse(results);
		return res.status(200).json(restructured);
	} catch (error) {
		return res.status(500).json({
			error: 'Failed to fetch QuickBooks data',
			details: error.message,
		});
	}
};

const getPohodaToken = async (req, res) => {
	const { client_id, client_secret } = req.body;

	console.log('Received /pohoda/token request with body:', req.body);

	if (!client_id || !client_secret) {
		console.log('Missing client_id or client_secret in request body');
		return res
			.status(400)
			.json({ error: 'client_id and client_secret are required in body' });
	}

	const authHeader = `Basic ${Buffer.from(
		`${client_id}:${client_secret}`
	).toString('base64')}`;

	try {
		const tokenResponse = await axios.post(
			POHODA_TOKEN_ENDPOINT,
			new URLSearchParams({
				grant_type: 'client_credentials',
				scope: POHODA_SCOPE,
			}),
			{
				headers: {
					Authorization: authHeader,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			}
		);
		console.log('Pohoda token response:', tokenResponse.data);
		res.json(tokenResponse.data);
	} catch (error) {
		console.error('Failed to obtain Pohoda access token:', {
			status: error.response?.status,
			data: error.response?.data,
			message: error.message,
		});
		res.status(401).json({
			error: 'Failed to obtain Pohoda access token',
			details: error.response ? error.response.data : error.message,
		});
	}
};

/**
 * Fetches Pohoda received invoices
 * @route GET /pohoda/received-invoices
 */
const getPohodaReceivedInvoices = async (req, res) => {
	const authorization = req.headers.authorization;

	if (!authorization) {
		return res.status(401).json({ error: 'Authorization header is required' });
	}

	try {
		const response = await axios.get(
			`${POHODA_API_BASE_URL}/received-invoices`,
			{
				headers: {
					Authorization: authorization,
					Accept: 'application/json',
				},
			}
		);
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

/**
 * Fetches Pohoda received orders
 * @route GET /pohoda/received-orders
 */
const getPohodaReceivedOrders = async (req, res) => {
	const authorization = req.headers.authorization;

	if (!authorization) {
		return res.status(401).json({ error: 'Authorization header is required' });
	}

	try {
		const response = await axios.get(`${POHODA_API_BASE_URL}/received-orders`, {
			headers: {
				Authorization: authorization,
				Accept: 'application/json',
			},
		});
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

/**
 * Fetches Pohoda issued invoices
 * @route GET /pohoda/issued-invoices
 */
const getPohodaIssuedInvoices = async (req, res) => {
	const authorization = req.headers.authorization;

	if (!authorization) {
		return res.status(401).json({ error: 'Authorization header is required' });
	}

	try {
		const response = await axios.get(`${POHODA_API_BASE_URL}/issued-invoices`, {
			headers: {
				Authorization: authorization,
				Accept: 'application/json',
			},
		});
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

/**
 * Fetches Pohoda stock items
 * @route GET /pohoda/stock-items
 */
const getPohodaStockItems = async (req, res) => {
	const authorization = req.headers.authorization;

	if (!authorization) {
		return res.status(401).json({ error: 'Authorization header is required' });
	}

	try {
		const response = await axios.get(`${POHODA_API_BASE_URL}/stock-items`, {
			headers: {
				Authorization: authorization,
				Accept: 'application/json',
			},
		});
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

/**
 * Fetches Pohoda bills
 * @route GET /pohoda/bills
 */
const getPohodaBills = async (req, res) => {
	const authorization = req.headers.authorization;

	if (!authorization) {
		return res.status(401).json({ error: 'Authorization header is required' });
	}

	try {
		const response = await axios.get(`${POHODA_API_BASE_URL}/bills`, {
			headers: {
				Authorization: authorization,
				Accept: 'application/json',
			},
		});
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

/**
 * Fetches Pohoda profit and loss report
 * @route GET /pohoda/profit-loss-report
 */
const getPohodaProfitLossReport = async (req, res) => {
	const { from, to } = req.query;
	const authorization = req.headers.authorization;

	if (!from || !to || !authorization) {
		return res.status(400).json({
			error: 'from, to dates, and Authorization header are required',
		});
	}

	try {
		const response = await axios.get(
			`${POHODA_API_BASE_URL}/reports/profit-loss?from=${from}&to=${to}`,
			{
				headers: {
					Authorization: authorization,
					Accept: 'application/json',
				},
			}
		);
		res.json(response.data);
	} catch (error) {
		const status = error.response ? error.response.status : 500;
		const message = error.response ? error.response.data : error.message;
		res.status(status).json({ error: message });
	}
};

export {
	quickbooksConnect,
	quickbooksCallback,
	quickbooksAllData,
	getPohodaToken,
	getPohodaReceivedInvoices,
	getPohodaReceivedOrders,
	getPohodaIssuedInvoices,
	getPohodaStockItems,
	getPohodaBills,
	getPohodaProfitLossReport,
};
