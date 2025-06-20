import dotenv from 'dotenv';
dotenv.config();
import winston from 'winston';
import { Redis } from '@upstash/redis';
// Logger configuration
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'error.log', level: 'error' }),
		new winston.transports.File({ filename: 'combined.log' }),
	],
});

/**
 * Calculates a dynamic result from user-specified parameters and operations.
 * Processes categories one by one to avoid memory issues with large datasets.
 * Removes used parameters and adds result to each category's data array.
 * @param {Array} dashboardData - Array of category objects.
 * @param {Array<string>} parameters - Array of parameter titles (e.g., ["DischargeDate", "AdmissionDate"]).
 * @param {Array<string>} operations - Array of operations (e.g., ["minus"]).
 * @param {string} resultName - Name for the result (e.g., "Days_spent").
 * @param {string} calculationType - Type of calculation (default: 'numeric').
 * @returns {Array} Updated dashboard data with results added.
 */
export function calculateDynamicParameters(
	dashboardData,
	parameters,
	operations,
	resultName,
	calculationType = 'numeric'
) {
	// Input validation
	if (!Array.isArray(dashboardData)) {
		logger.warn('Invalid dashboardData: must be an array', {
			type: typeof dashboardData,
		});
		return Array.isArray(dashboardData) ? [...dashboardData] : [];
	}

	if (!Array.isArray(parameters) || parameters.length < 2) {
		logger.warn('Invalid parameters: at least two required', { parameters });
		return dashboardData;
	}

	if (
		!Array.isArray(operations) ||
		operations.length !== parameters.length - 1
	) {
		logger.warn('Invalid operations: must be one less than parameters', {
			operations,
			expected: parameters.length - 1,
		});
		return dashboardData;
	}

	if (typeof resultName !== 'string' || !resultName.trim()) {
		logger.warn('Invalid resultName: must be a non-empty string', {
			resultName,
		});
		return dashboardData;
	}

	// Validate operations based on calculation type
	const validOperations =
		calculationType === 'numeric'
			? ['plus', 'minus', 'multiply', 'divide']
			: ['minus'];
	if (!operations.every((op) => validOperations.includes(op))) {
		logger.warn(`Invalid operation: must be ${validOperations.join(', ')}`, {
			operations,
			calculationType,
		});
		return dashboardData;
	}

	if (
		calculationType === 'date' &&
		(parameters.length !== 2 || operations[0] !== 'minus')
	) {
		logger.warn(
			'Date calculation requires exactly two parameters and minus operation',
			{ parameters, operations }
		);
		return dashboardData;
	}

	const startTime = Date.now();
	const updatedData = [];

	// Process categories one by one
	for (const [catIndex, category] of dashboardData.entries()) {
		// Validate category structure
		if (
			!category ||
			typeof category !== 'object' ||
			!Array.isArray(category.data)
		) {
			logger.warn('Skipping invalid category', {
				cat: category?.cat,
				catIndex,
			});
			updatedData.push(category);
			continue;
		}

		// Find parameter entries
		const paramData = parameters.map((param, paramIndex) => ({
			param,
			data: category.data.find((d) => d.d[0]?.t === param),
			paramIndex,
		}));

		// Skip if any parameter is missing
		if (!paramData.every((pd) => pd.data)) {
			logger.debug('Skipping category: missing parameters', {
				cat: category.cat,
				parameters,
				missing: parameters.filter(
					(p) => !category.data.some((d) => d.d[0]?.t === p)
				),
			});
			updatedData.push(category);
			continue;
		}

		// Handle numeric calculation
		const values = paramData.map((pd) => {
			const value = pd.data?.d[0]?.v;
			return typeof value === 'number' ? value : parseFloat(value) || 0;
		});

		// Validate numeric values
		if (!values.every((v) => typeof v === 'number' && !isNaN(v))) {
			logger.debug('Skipping calculation: non-numeric parameters', {
				cat: category.cat,
				parameters,
				values,
			});
			updatedData.push(category);
			continue;
		}

		// Perform numeric calculation
		let result = values[0];
		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			const nextValue = values[i + 1];
			switch (op) {
				case 'plus':
					result += nextValue;
					break;
				case 'minus':
					result -= nextValue;
					break;
				case 'multiply':
					result *= nextValue;
					break;
				case 'divide':
					result = nextValue !== 0 ? result / nextValue : null;
					break;
				default:
					logger.warn('Unknown operation', {
						operation: op,
						cat: category.cat,
					});
					updatedData.push(category);
					continue;
			}
			if (result === null || !isFinite(result)) {
				logger.debug('Calculation failed: invalid result', {
					cat: category.cat,
					operation: op,
					values,
					result,
				});
				updatedData.push(category);
				continue;
			}
		}

		// Create new entry
		const newData = category.data.filter(
			(d) => !parameters.includes(d.d[0]?.t)
		);
		newData.push({
			i: `${category.cat}-${resultName || 'calculated_result'}`,
			d: [
				{
					t: resultName || 'Calculated_Result',
					v: result,
					d:
						paramData[0]?.data?.d[0]?.d instanceof Date
							? paramData[0].data.d[0].d
							: new Date(paramData[0]?.data?.d[0]?.d || Date.now()),
				},
			],
		});

		logger.debug('Performed numeric calculation', {
			cat: category.cat,
			parameters,
			operation: operations[0],
			result,
		});

		updatedData.push({
			...category,
			data: newData,
		});
	}

	const duration = (Date.now() - startTime) / 1000;
	logger.info('Calculated dynamic parameters', {
		resultName,
		parameters,
		operations,
		calculationType,
		categories: updatedData.length,
		duration,
	});

	return updatedData;
}

// Example input with three categories
const exampleInput = [
	{
		cat: 'e3e70682-c209-4cac-a29f-6fbed82c07cd',
		data: [
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-customer-name',
				d: [
					{
						t: 'Customer_Name',
						v: 'Amanda Johnson',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-customer-email',
				d: [
					{
						t: 'Customer_Email',
						v: 38,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-product',
				d: [
					{
						t: 'Product',
						v: 'Smartphone',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-category',
				d: [
					{
						t: 'Category',
						v: 'Electronics',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-quantity',
				d: [
					{
						t: 'Quantity',
						v: 1,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-price',
				d: [
					{
						t: 'Price',
						v: 265.46,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-order-date',
				d: [
					{
						t: 'Order_Date',
						v: 1,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-shipping-address',
				d: [
					{
						t: 'Shipping_Address',
						v: 77360,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'e3e70682-c209-4cac-a29f-6fbed82c07cd-order-status',
				d: [
					{
						t: 'Order_Status',
						v: 'Shipped',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
		],
		comb: [],
		sum: [],
		chart: 'Area',
		ids: [],
	},
	{
		cat: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455',
		data: [
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-customer-name',
				d: [
					{
						t: 'Customer_Name',
						v: 'Stacy Dixon',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-customer-email',
				d: [
					{
						t: 'Customer_Email',
						v: 'zsutton@gmail.com',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-product',
				d: [
					{
						t: 'Product',
						v: 'Keyboard',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-category',
				d: [
					{
						t: 'Category',
						v: 'Office Supplies',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-quantity',
				d: [
					{
						t: 'Quantity',
						v: 4,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-price',
				d: [
					{
						t: 'Price',
						v: 478.65,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-order-date',
				d: [
					{
						t: 'Order_Date',
						v: 12,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-shipping-address',
				d: [
					{
						t: 'Shipping_Address',
						v: 54,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f728b4fa-4248-4e3a-8a5d-2f346baa9455-order-status',
				d: [
					{
						t: 'Order_Status',
						v: 'Returned',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
		],
		comb: [],
		sum: [],
		chart: 'Area',
		ids: [],
	},
	{
		cat: 'eb1167b3-67a9-4378-bc65-c1e582e2e662',
		data: [
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-customer-name',
				d: [
					{
						t: 'Customer_Name',
						v: 'Brent Flowers',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-customer-email',
				d: [
					{
						t: 'Customer_Email',
						v: 'mtyler@hatfield.biz',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-product',
				d: [
					{
						t: 'Product',
						v: 'Tablet',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-category',
				d: [
					{
						t: 'Category',
						v: 'Office Supplies',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-quantity',
				d: [
					{
						t: 'Quantity',
						v: 2,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-price',
				d: [
					{
						t: 'Price',
						v: 835.83,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-order-date',
				d: [
					{
						t: 'Order_Date',
						v: 4,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-shipping-address',
				d: [
					{
						t: 'Shipping_Address',
						v: 55064,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'eb1167b3-67a9-4378-bc65-c1e582e2e662-order-status',
				d: [
					{
						t: 'Order_Status',
						v: 'Returned',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
		],
		comb: [],
		sum: [],
		chart: 'Area',
		ids: [],
	},
	{
		cat: 'f7c1bd87-4da5-4709-9471-3d60c8a70639',
		data: [
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-customer-name',
				d: [
					{
						t: 'Customer_Name',
						v: 'Mary Lang',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-customer-email',
				d: [
					{
						t: 'Customer_Email',
						v: 'bdavis@martin-ward.com',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-product',
				d: [
					{
						t: 'Product',
						v: 'Mouse',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-category',
				d: [
					{
						t: 'Category',
						v: 'Office Supplies',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-quantity',
				d: [
					{
						t: 'Quantity',
						v: 1,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-price',
				d: [
					{
						t: 'Price',
						v: 238.1,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-order-date',
				d: [
					{
						t: 'Order_Date',
						v: 3,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-shipping-address',
				d: [
					{
						t: 'Shipping_Address',
						v: 309,
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
			{
				i: 'f7c1bd87-4da5-4709-9471-3d60c8a70639-order-status',
				d: [
					{
						t: 'Order_Status',
						v: 'Delivered',
						d: '2025-06-20T00:00:00.000Z',
					},
				],
			},
		],
		comb: [],
		sum: [],
		chart: 'Area',
		ids: [],
	},
];

// Test the function
const parameters = ['Price', 'Quantity'];
const operations = ['multiply'];
const resultName = 'Gross';

const result = calculateDynamicParameters(
	exampleInput,
	parameters,
	operations,
	resultName,
	'numeric'
);

console.log(JSON.stringify(result, null, 2));

const redis = new Redis({
	url: process.env.UPSTASH_REDIS_REST_URL,
	token: process.env.UPSTASH_REDIS_REST_TOKEN,
});
redis.get('test').then(console.log).catch(console.error);
