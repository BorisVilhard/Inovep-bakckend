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

const EntrySchema = new mongoose.Schema(
	{
		title: { type: String, required: true },
		value: { type: mongoose.Schema.Types.Mixed, required: true },
		date: { type: Date, required: true },
		fileName: { type: String, required: true },
	},
	{ _id: false }
);

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

const CombinedChartSchema = new mongoose.Schema(
	{
		id: { type: String, required: true, unique: true },
		chartType: { type: String, required: true, enum: validChartTypes },
		chartIds: { type: [String], required: true },
		data: [EntrySchema],
	},
	{ _id: false }
);

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

const FileRecordSchema = new mongoose.Schema(
	{
		fileId: { type: String },
		filename: { type: String, required: true },
		content: [DashboardCategorySchema],
		lastUpdate: { type: Date },
		source: { type: String, enum: ['local', 'google'], default: 'local' },
		isChunked: { type: Boolean, default: false },
		chunkCount: { type: Number, default: 1 },
		monitoring: {
			status: { type: String, enum: ['active', 'expired'], default: 'active' },
			expireDate: { type: Date },
			folderId: { type: String, default: null },
		},
	},
	{ _id: false }
);

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
