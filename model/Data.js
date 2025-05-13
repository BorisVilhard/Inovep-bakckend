import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';

// Valid chart types for chartType field
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

// Schema for individual entries
const EntrySchema = new mongoose.Schema(
	{
		title: { type: String, required: true, trim: true, maxlength: 100 },
		value: { type: mongoose.Schema.Types.Mixed, required: true },
		date: { type: Date, required: true },
		fileName: { type: String, required: true, trim: true, maxlength: 255 },
	},
	{ _id: false }
);

// Schema for indexed entries
const IndexedEntriesSchema = new mongoose.Schema(
	{
		id: { type: String, required: true, trim: true, maxlength: 100 },
		chartType: { type: String, required: true, enum: validChartTypes },
		data: {
			type: [EntrySchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'Data array cannot be empty'],
		},
		isChartTypeChanged: { type: Boolean, default: false },
		fileName: { type: String, required: true, trim: true, maxlength: 255 },
	},
	{ _id: false }
);

// Schema for combined charts
const CombinedChartSchema = new mongoose.Schema(
	{
		id: {
			type: String,
			required: true,
			unique: true,
			trim: true,
			maxlength: 100,
		},
		chartType: { type: String, required: true, enum: validChartTypes },
		chartIds: {
			type: [String],
			required: true,
			validate: [
				(arr) => arr.length >= 2,
				'At least two chartIds are required',
			],
		},
		data: {
			type: [EntrySchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'Data array cannot be empty'],
		},
	},
	{ _id: false }
);

// Schema for dashboard categories
const DashboardCategorySchema = new mongoose.Schema(
	{
		categoryName: { type: String, required: true, trim: true, maxlength: 100 },
		mainData: {
			type: [IndexedEntriesSchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'MainData array cannot be empty'],
		},
		combinedData: { type: [CombinedChartSchema], default: [] },
		summaryData: { type: [EntrySchema], default: [] },
		appliedChartType: { type: String, enum: validChartTypes },
		checkedIds: { type: [String], default: [] },
	},
	{ _id: false }
);

// Schema for file data (embedded in Dashboard)
const FileDataSchema = new mongoose.Schema(
	{
		fileId: { type: String, trim: true }, // For GridFS or cloud file ID
		filename: { type: String, required: true, trim: true, maxlength: 255 },
		content: { type: Buffer, required: false }, // Added for BSON storage
		lastUpdate: { type: Date, default: Date.now },
		source: { type: String, enum: ['local', 'google'], default: 'local' },
		isChunked: { type: Boolean, default: false },
		chunkCount: { type: Number, default: 1, min: 1 },
		monitoring: {
			status: { type: String, enum: ['active', 'expired'], default: 'active' },
			expireDate: { type: Date },
			folderId: { type: String, default: null, trim: true, maxlength: 100 },
		},
	},
	{ _id: true }
);

// Dashboard Schema
const DashboardSchema = new mongoose.Schema(
	{
		dashboardName: {
			type: String,
			required: true,
			trim: true,
			maxlength: 100,
			index: true,
		},
		dashboardData: {
			type: [DashboardCategorySchema],
			default: [],
		},
		files: [FileDataSchema],
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		createdAt: {
			type: Date,
			default: Date.now,
		},
		updatedAt: {
			type: Date,
			default: Date.now,
		},
		deletedAt: { type: Date, default: null },
	},
	{
		timestamps: true,
		versionKey: false,
	}
);

// Indexes for performance
DashboardSchema.index({ userId: 1, _id: 1 });
DashboardSchema.index({ userId: 1, dashboardName: 1 });
DashboardSchema.index({ 'files.filename': 1 });
DashboardSchema.index({ 'dashboardData.mainData.data.fileName': 1 });
DashboardSchema.index({ 'dashboardData.combinedData.data.fileName': 1 }); // Added for combinedData
DashboardSchema.index({ 'dashboardData.categoryName': 1 });
DashboardSchema.index({ 'dashboardData.mainData.id': 1 });
DashboardSchema.index(
	{ 'files.monitoring.status': 1, 'files.monitoring.expireDate': 1 },
	{ partialFilterExpression: { 'files.monitoring.status': 'expired' } }
);

// Pre-save middleware to update timestamps
DashboardSchema.pre('save', function (next) {
	this.updatedAt = new Date();
	next();
});

// Pre-remove middleware to clean up GridFS files
DashboardSchema.pre('remove', async function (next) {
	try {
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});
		const fileIds = this.files
			.filter((file) => file.fileId && file.isChunked)
			.map((file) => new mongoose.Types.ObjectId(file.fileId));

		if (fileIds.length > 0) {
			await Promise.all(
				fileIds.map(async (fileId) => {
					try {
						await gfs.delete(fileId);
					} catch (err) {
						console.warn(
							`Error deleting GridFS file ${fileId}: ${err.message}`
						);
					}
				})
			);
		}
		next();
	} catch (err) {
		next(err);
	}
});

// Static method to delete entire dashboardData
DashboardSchema.statics.deleteDashboardData = async function (dashboardId) {
	try {
		const start = Date.now();
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});

		const dashboard = await this.findById(dashboardId, {
			'dashboardData.mainData.data.fileName': 1,
			'dashboardData.combinedData.data.fileName': 1,
			files: 1,
		}).lean();

		if (!dashboard) {
			throw new Error('Dashboard not found');
		}

		const fileNames = new Set();
		const fileIds = new Set();

		dashboard.dashboardData.forEach((category) => {
			category.mainData?.forEach((entry) => {
				if (entry.data) {
					entry.data.forEach((item) => fileNames.add(item.fileName));
				}
			});
			category.combinedData?.forEach((chart) => {
				if (chart.data) {
					chart.data.forEach((item) => fileNames.add(item.fileName));
				}
			});
		});
		dashboard.files?.forEach((file) => {
			if (file.fileId && file.isChunked) {
				fileIds.add(file.fileId);
			}
		});

		const deleteFilePromises = [...fileIds].map(async (fileId) => {
			try {
				await gfs.delete(new mongoose.Types.ObjectId(fileId));
				return 1;
			} catch (err) {
				console.warn(`Failed to delete GridFS file ${fileId}: ${err.message}`);
				return 0;
			}
		});
		const deletedFiles = (await Promise.all(deleteFilePromises)).reduce(
			(sum, count) => sum + count,
			0
		);

		const result = await this.updateOne(
			{ _id: dashboardId },
			[
				{
					$set: {
						dashboardData: [],
						files: {
							$filter: {
								input: '$files',
								as: 'file',
								cond: { $not: { $in: ['$$file.fileId', [...fileIds]] } },
							},
						},
					},
				},
			],
			{ writeConcern: { w: 1 } }
		);

		console.log(
			`Deletion took: ${Date.now() - start}ms, Deleted files: ${deletedFiles}`
		);
		return { modifiedCount: result.modifiedCount, deletedFiles };
	} catch (err) {
		console.error(`Error deleting dashboardData: ${err.message}`);
		throw err;
	}
};

// Static method to delete specific category
DashboardSchema.statics.deleteDashboardCategory = async function (
	dashboardId,
	categoryName
) {
	try {
		const start = Date.now();
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});

		const dashboard = await this.findOne(
			{ _id: dashboardId, 'dashboardData.categoryName': categoryName },
			{ 'dashboardData.$': 1, files: 1 }
		).lean();

		if (!dashboard) {
			throw new Error('Category not found');
		}

		const category = dashboard.dashboardData[0];
		const fileNames = new Set();
		const fileIds = new Set();

		category.mainData?.forEach((entry) => {
			if (entry.data) {
				entry.data.forEach((item) => fileNames.add(item.fileName));
			}
		});
		category.combinedData?.forEach((chart) => {
			if (chart.data) {
				chart.data.forEach((item) => fileNames.add(item.fileName));
			}
		});
		dashboard.files?.forEach((file) => {
			if (file.fileId && file.isChunked && fileNames.has(file.filename)) {
				fileIds.add(file.fileId);
			}
		});

		const deleteFilePromises = [...fileIds].map(async (fileId) => {
			try {
				await gfs.delete(new mongoose.Types.ObjectId(fileId));
				return 1;
			} catch (err) {
				console.warn(`Failed to delete GridFS file ${fileId}: ${err.message}`);
				return 0;
			}
		});
		const deletedFiles = (await Promise.all(deleteFilePromises)).reduce(
			(sum, count) => sum + count,
			0
		);

		const result = await this.updateOne(
			{ _id: dashboardId },
			[
				{
					$set: {
						dashboardData: {
							$filter: {
								input: '$dashboardData',
								as: 'category',
								cond: { $ne: ['$$category.categoryName', categoryName] },
							},
						},
						files: {
							$filter: {
								input: '$files',
								as: 'file',
								cond: { $not: { $in: ['$$file.fileId', [...fileIds]] } },
							},
						},
					},
				},
			],
			{ writeConcern: { w: 1 } }
		);

		console.log(
			`Category deletion took: ${
				Date.now() - start
			}ms, Deleted files: ${deletedFiles}`
		);
		return { modifiedCount: result.modifiedCount, deletedFiles };
	} catch (err) {
		console.error(`Error deleting category: ${err.message}`);
		throw err;
	}
};

// Static method to delete large data and associated GridFS files
DashboardSchema.statics.deleteLargeData = async function (
	userId,
	dashboardName = null
) {
	try {
		if (!mongoose.Types.ObjectId.isValid(userId)) {
			throw new Error('Invalid userId');
		}

		const query = { userId: new mongoose.Types.ObjectId(userId) };
		if (dashboardName) {
			query.dashboardName = dashboardName;
		}

		const dashboards = await this.find(query, { files: 1 }).lean();
		const fileIds = dashboards
			.flatMap((dashboard) => dashboard.files || [])
			.filter((file) => file.fileId && file.isChunked)
			.map((file) => new mongoose.Types.ObjectId(file.fileId));

		let deletedFiles = 0;
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});
		if (fileIds.length > 0) {
			const deletePromises = fileIds.map(async (fileId) => {
				try {
					await gfs.delete(fileId);
					return 1;
				} catch (err) {
					console.warn(
						`Failed to delete GridFS file ${fileId}: ${err.message}`
					);
					return 0;
				}
			});
			const results = await Promise.all(deletePromises);
			deletedFiles = results.reduce((sum, count) => sum + count, 0);
		}

		const { deletedCount } = await this.deleteMany(query);

		return { deletedDashboards: deletedCount, deletedFiles };
	} catch (err) {
		console.error(`Error deleting data: ${err.message}`);
		throw err;
	}
};

// Static method to clean up expired files
DashboardSchema.statics.deleteExpiredFiles = async function () {
	try {
		const dashboards = await this.find(
			{
				'files.monitoring.status': 'expired',
				'files.monitoring.expireDate': { $lt: new Date() },
			},
			{ files: 1 }
		).lean();

		const fileIds = dashboards
			.flatMap((dashboard) => dashboard.files)
			.filter(
				(file) =>
					file.monitoring.status === 'expired' && file.fileId && file.isChunked
			)
			.map((file) => new mongoose.Types.ObjectId(file.fileId));

		let deletedFiles = 0;
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});
		if (fileIds.length > 0) {
			const deletePromises = fileIds.map(async (fileId) => {
				try {
					await gfs.delete(fileId);
					return 1;
				} catch (err) {
					console.warn(
						`Failed to delete GridFS file ${fileId}: ${err.message}`
					);
					return 0;
				}
			});
			const results = await Promise.all(deletePromises);
			deletedFiles = results.reduce((sum, count) => sum + count, 0);
		}

		await this.updateMany(
			{
				'files.monitoring.status': 'expired',
				'files.monitoring.expireDate': { $lt: new Date() },
			},
			{ $pull: { files: { 'monitoring.status': 'expired' } } }
		);

		return { deletedFiles };
	} catch (err) {
		console.error(`Error deleting expired files: ${err.message}`);
		throw err;
	}
};

const Dashboard = mongoose.model('Dashboard', DashboardSchema);

export default Dashboard;
