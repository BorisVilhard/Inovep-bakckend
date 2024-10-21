// models/Data.js

import mongoose from 'mongoose';

const EntrySchema = new mongoose.Schema({
	title: { type: String, required: true },
	value: { type: mongoose.Schema.Types.Mixed, required: true },
	date: { type: Date, required: true },
	fileName: { type: String, required: true },
});

const IndexedEntriesSchema = new mongoose.Schema({
	id: { type: String, required: true },
	chartType: { type: String, required: true },
	data: [EntrySchema],
	isChartTypeChanged: { type: Boolean, default: false },
	fileName: { type: String, required: true },
});

const DashboardCategorySchema = new mongoose.Schema({
	categoryName: { type: String, required: true },
	mainData: [IndexedEntriesSchema],
	combinedData: { type: [Number], default: [] },
});

const DashboardSchema = new mongoose.Schema({
	dashboardName: { type: String, required: true },
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
