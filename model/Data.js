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
 * Note the new `folderId` field in `monitoring`.
 */
const FileRecordSchema = new mongoose.Schema(
	{
		fileId: { type: String }, // for cloud files (or folder ID)
		filename: { type: String, required: true },
		content: [DashboardCategorySchema],
		lastUpdate: { type: Date },
		source: { type: String, enum: ['local', 'google'], default: 'local' },
		monitoring: {
			status: { type: String, enum: ['active', 'expired'], default: 'active' },
			expireDate: { type: Date }, // Date that the channel expires
			folderId: { type: String, default: null }, // Null if this is file-based monitoring
			// folderName: { type: String }, // (Optional) only if you still want to store folderName
		},
	},
	{ _id: false }
);

/**
 * DashboardSchema – the parent dashboard document.
 */
const DashboardSchema = new mongoose.Schema(
	{
		dashboardName: { type: String, required: true, unique: true },
		dashboardData: [DashboardCategorySchema],
		files: { type: [FileRecordSchema], default: [] },
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
	},
	{
		optimisticConcurrency: false,
		versionKey: false,
		timestamps: true,
	}
);

const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
