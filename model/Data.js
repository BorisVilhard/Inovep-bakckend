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
 * EntrySchema
 * - Represents a single data point entry.
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
 * IndexedEntriesSchema
 * - Represents a chart’s main data with an identifier and type.
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
 * CombinedChartSchema
 * - Represents a chart that aggregates data from multiple charts.
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
 * DashboardCategorySchema
 * - Represents a category within a dashboard that contains one or more charts.
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
 * DashboardSchema
 * - Represents the dashboard document containing metadata, an array of categories,
 *   a list of uploaded file records, and the owning user.
 *
 * Options:
 *   - optimisticConcurrency: false disables version-based update conflicts.
 *   - timestamps: adds createdAt and updatedAt fields.
 */
const DashboardSchema = new mongoose.Schema(
	{
		dashboardName: { type: String, required: true, unique: true },
		dashboardData: [DashboardCategorySchema],
		files: {
			type: [
				{
					fileId: { type: String },
					filename: { type: String, required: true },
					content: [DashboardCategorySchema],
					lastUpdate: { type: Date },
				},
			],
			default: [],
		},
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
