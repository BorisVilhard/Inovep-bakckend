// models/Data.js

import mongoose from 'mongoose';

// Define Entry Schema
const EntrySchema = new mongoose.Schema({
	title: { type: String, required: true },
	value: { type: mongoose.Schema.Types.Mixed, required: true },
	date: { type: String, required: true },
});

// Define IndexedEntries Schema
const IndexedEntriesSchema = new mongoose.Schema({
	chartType: { type: String, required: true },
	id: { type: Number, required: true },
	data: [EntrySchema],
	isChartTypeChanged: { type: Boolean, default: false },
});

// Define DashboardCategory Schema
const DashboardCategorySchema = new mongoose.Schema({
	category: { type: String, required: true },
	mainData: [IndexedEntriesSchema],
	combinedData: [Number],
});

// Define Data Schema
const DataSchema = new mongoose.Schema({
	user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
	DashboardId: { type: Number, required: true },
	dashboardData: [DashboardCategorySchema],
});

const Data = mongoose.model('Data', DataSchema);

export default Data;
