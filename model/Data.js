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
		value: { type: mongoose.Schema.Types.Mixed, required: true }, // Supports strings, numbers, etc.
		date: { type: String, required: true }, // Store as string (e.g., "2025-03-01")
		fileName: { type: String, required: true },
	},
	{ _id: false }
);

const IndexedEntriesSchema = new mongoose.Schema(
	{
		id: { type: String, required: true },
		chartType: { type: String, required: true, enum: validChartTypes },
		data: { type: [EntrySchema], required: true },
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
		data: { type: [EntrySchema], required: true },
	},
	{ _id: false }
);

const DashboardCategorySchema = new mongoose.Schema(
	{
		categoryName: { type: String, required: true }, // e.g., "Salary", "Groceries"
		mainData: { type: [IndexedEntriesSchema], required: true },
		combinedData: { type: [CombinedChartSchema], default: [] },
		summaryData: { type: [EntrySchema], default: [] },
		appliedChartType: { type: String, enum: validChartTypes },
		checkedIds: { type: [String], default: [] },
	},
	{ _id: false }
);

const FileRecordSchema = new mongoose.Schema(
	{
		fileId: { type: String }, // Optional for cloud files
		filename: { type: String, required: true },
		content: { type: [DashboardCategorySchema], required: true }, // Stores dashboardData for the file
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
		dashboardName: { type: String, required: true },
		dashboardData: { type: [DashboardCategorySchema], default: [] },
		files: { type: [FileRecordSchema], default: [] },
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
		createdAt: { type: Date, default: Date.now },
		updatedAt: { type: Date, default: Date.now },
	},
	{
		optimisticConcurrency: false,
		versionKey: false,
		timestamps: true, // Automatically manages createdAt and updatedAt
	}
);

// Update updatedAt on save
DashboardSchema.pre('save', function (next) {
	this.updatedAt = new Date();
	next();
});

const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
