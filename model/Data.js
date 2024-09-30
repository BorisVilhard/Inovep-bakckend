// models/Data.js

import mongoose from 'mongoose';

const Schema = mongoose.Schema;

// Updated DataSchema to allow 'value' as String or Number and 'date' as String
const DataSchema = new Schema({
	title: {
		type: String,
		required: true,
	},
	value: {
		type: Schema.Types.Mixed, // Allows both String and Number
		required: true,
	},
	date: {
		type: String, // Storing as ISO string
		required: true,
	},
});

// Updated ChartSchema
const ChartSchema = new Schema({
	chartType: {
		type: String,
		enum: [
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
		],
		required: true,
	},
	data: {
		type: [DataSchema],
		required: true,
	},
	id: {
		type: Number,
		required: true,
	},
	isChartTypeChanged: {
		type: Boolean,
		default: false,
	},
});

// Updated DashboardCategorySchema
const DashboardCategorySchema = new Schema({
	categoryName: {
		type: String,
		required: true,
	},
	mainData: {
		type: [ChartSchema],
		required: true,
	},
	combinedData: {
		type: [Number],
		default: [],
	},
});

// Updated DashboardSchema
const DashboardSchema = new Schema({
	DashboardId: {
		type: Number,
		required: true,
		unique: true,
	},
	dashboardData: {
		type: [DashboardCategorySchema],
		required: true,
	},
	userId: {
		type: Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},
});

export default mongoose.model('Dashboard', DashboardSchema);
