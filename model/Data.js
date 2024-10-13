// models/Data.js
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const { Schema } = mongoose;

// DataSchema
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
		type: String, // Store date as a string in ISO format
		required: true,
	},
	fileName: {
		type: String,
		required: true,
	},
});

// ChartSchema
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
			'Area', // Include 'Area' if needed
		],
		required: true,
	},
	id: {
		type: String,
		required: true,
		default: () => uuidv4(), // Generate UUID
	},
	data: {
		type: [DataSchema],
		required: true,
	},
	isChartTypeChanged: {
		type: Boolean,
		default: false,
	},
	fileName: {
		type: String,
		required: true,
	},
});

// DashboardCategorySchema
const DashboardCategorySchema = new Schema(
	{
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
	},
	{ _id: false } // Prevent Mongoose from creating _id fields for subdocuments
);

// DashboardSchema
const DashboardSchema = new Schema({
	dashboardData: {
		type: [DashboardCategorySchema],
		required: true,
	},
	files: [
		{
			filename: String,
			content: Schema.Types.Mixed, // Store the content of the file here
		},
	],
	userId: {
		type: Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},
});

// Export the Dashboard model
const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
