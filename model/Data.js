// models/Dashboard.js
import mongoose from 'mongoose';

const validChartTypes = [
	'EntryArea',
	'IndexArea',
	'EntryLine',
	'IndexLine',
	'TradingLine',
	'IndexBar',
	'Bar',
	'Pie',
	'Line',
	'Radar',
	'Area',
];

/**
 * EntrySchema – represents a single data point.
 */
const EntrySchema = new mongoose.Schema(
	{
		title: { type: String, required: true },
		value: { type: mongoose.Schema.Types.Mixed, required: true },
		date: { type: Date, required: true },
		fileName: { type: String, required: true },
	},
	{ _id: false }
);

/**
 * IndexedEntriesSchema – represents a chart’s main data.
 */
const IndexedEntriesSchema = new mongoose.Schema(
	{
		id: { type: String, required: true },
		chartType: { type: String, required: true, enum: validChartTypes },
		data: [EntrySchema],
		isChartTypeChanged: { type: Boolean, default: false },
		fileName: { type: String, required: true },
	},
	{ _id: false }
);

/**
 * CombinedChartSchema – represents a chart aggregating data from multiple charts.
 */
const CombinedChartSchema = new mongoose.Schema(
	{
		id: { type: String, required: true, unique: true },
		chartType: { type: String, required: true, enum: validChartTypes },
		chartIds: { type: [String], required: true },
		data: [EntrySchema],
	},
	{ _id: false }
);

/**
 * DashboardCategorySchema – represents a category inside a dashboard.
 */
const DashboardCategorySchema = new mongoose.Schema(
	{
		categoryName: { type: String, required: true },
		mainData: [IndexedEntriesSchema],
		combinedData: { type: [CombinedChartSchema], default: [] },
		summaryData: { type: [EntrySchema], default: [] },
		appliedChartType: { type: String, enum: validChartTypes },
		checkedIds: { type: [String], default: [] },
	},
	{ _id: false }
);

/**
 * FileRecordSchema – represents a record for an uploaded file.
 */

const FileRecordSchema = new mongoose.Schema(
	{
		fileId: { type: String }, // Google Drive file ID
		filename: { type: String, required: true },
		content: { type: Array }, // Processed dashboard data
		lastUpdate: { type: Date }, // Last known modification time
		source: { type: String, enum: ['local', 'google'], default: 'local' },
		monitoring: {
			status: { type: String, enum: ['active', 'expired'], default: 'active' },
			expireDate: { type: Date }, // Webhook expiration
			folderId: { type: String, default: null }, // If part of a monitored folder
		},
	},
	{ _id: false }
);

const DashboardSchema = new mongoose.Schema(
	{
		dashboardName: { type: String, required: true },
		dashboardData: { type: Array, default: [] }, // Main dashboard data
		files: { type: [FileRecordSchema], default: [] }, // List of monitored files
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
	},
	{ timestamps: true }
);

const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
