// models/Data.js

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

// Entry Schema
const EntrySchema = new mongoose.Schema({
	title: { type: String, required: true },
	value: { type: mongoose.Schema.Types.Mixed, required: true },
	date: { type: Date, required: true },
	fileName: { type: String, required: true },
});

// IndexedEntries Schema
const IndexedEntriesSchema = new mongoose.Schema({
	id: { type: String, required: true },
	chartType: { type: String, required: true, enum: validChartTypes },
	data: [EntrySchema],
	isChartTypeChanged: { type: Boolean, default: false },
	fileName: { type: String, required: true },
});

// CombinedChart Schema
const CombinedChartSchema = new mongoose.Schema({
	id: { type: String, required: true, unique: true },
	chartType: { type: String, required: true, enum: validChartTypes },
	chartIds: { type: [String], required: true },
	data: [EntrySchema],
});

// DashboardCategory Schema
const DashboardCategorySchema = new mongoose.Schema({
	categoryName: { type: String, required: true },
	mainData: [IndexedEntriesSchema],
	combinedData: { type: [CombinedChartSchema], default: [] }, // Updated to use CombinedChartSchema
	summaryData: { type: [EntrySchema], default: [] },
	appliedChartType: { type: String, enum: validChartTypes },
	checkedIds: { type: [String], default: [] },
});

// Dashboard Schema
const DashboardSchema = new mongoose.Schema({
	dashboardName: { type: String, required: true, unique: true },
	dashboardData: [DashboardCategorySchema],
	files: {
		type: [
			{
				filename: { type: String, required: true },
				content: [DashboardCategorySchema],
			},
		],
		default: [],
	},
	userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
});

const Dashboard = mongoose.model('Dashboard', DashboardSchema);

export default Dashboard;
