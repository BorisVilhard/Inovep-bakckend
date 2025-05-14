import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import Queue from 'bull';
import winston from 'winston';
import {
	getCachedDashboard,
	setCachedDashboard,
	deleteCachedDashboard,
} from '../utils/cache.js';

// Logger configuration
const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'error.log', level: 'error' }),
		new winston.transports.File({ filename: 'combined.log' }),
	],
});

// Redis configuration for Bull queue
const REDIS_URL =
	process.env.UPSTASH_REDIS_REST_URL || 'https://crack-vervet-30777.upstash.io';
const REDIS_TOKEN =
	process.env.UPSTASH_REDIS_REST_TOKEN || 'YOUR_UPSTASH_REDIS_TOKEN';

// Background job queue for GridFS deletions
const deletionQueue = new Queue('gridfs-deletion', {
	redis: { url: REDIS_URL, password: REDIS_TOKEN },
});

// Valid chart types
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

// Schema for file data
const FileDataSchema = new mongoose.Schema(
	{
		fileId: { type: String, trim: true },
		filename: { type: String, required: true, trim: true, maxlength: 255 },
		content: { type: Buffer, required: false },
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

// Schema for dashboard data reference
const DashboardDataRefSchema = new mongoose.Schema(
	{
		fileId: { type: String, required: true, trim: true },
		filename: { type: String, required: true, trim: true, maxlength: 255 },
		isChunked: { type: Boolean, default: true },
		chunkCount: { type: Number, default: 1, min: 1 },
		lastUpdate: { type: Date, default: Date.now },
	},
	{ _id: false }
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
		dashboardDataRef: { type: DashboardDataRefSchema, default: null },
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

// Indexes
DashboardSchema.index({ userId: 1, _id: 1 });
DashboardSchema.index({ userId: 1, dashboardName: 1 });
DashboardSchema.index({ 'files.filename': 1 });
DashboardSchema.index({ 'dashboardDataRef.filename': 1 });
DashboardSchema.index(
	{ 'files.monitoring.status': 1, 'files.monitoring.expireDate': 1 },
	{ partialFilterExpression: { 'files.monitoring.status': 'expired' } }
);

// Pre-save middleware
DashboardSchema.pre('save', function (next) {
	this.updatedAt = new Date();
	next();
});

// Pre-remove middleware
DashboardSchema.pre('remove', async function (next) {
	try {
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});
		const fileIds = [];
		if (this.dashboardDataRef?.fileId && this.dashboardDataRef?.isChunked) {
			fileIds.push(new mongoose.Types.ObjectId(this.dashboardDataRef.fileId));
		}
		this.files
			.filter((file) => file.fileId && file.isChunked)
			.forEach((file) =>
				fileIds.push(new mongoose.Types.ObjectId(file.fileId))
			);

		if (fileIds.length > 0) {
			await deletionQueue.add({ fileIds }, { attempts: 3 });
			logger.info('Queued GridFS deletions for dashboard removal', {
				dashboardId: this._id,
				fileCount: fileIds.length,
			});
		}
		next();
	} catch (err) {
		logger.error('Error in pre-remove middleware', {
			dashboardId: this._id,
			error: err.message,
		});
		next(err);
	}
});

// Retrieve dashboard data from GridFS
DashboardSchema.methods.getDashboardData = async function () {
	if (!this.dashboardDataRef?.fileId || !this.dashboardDataRef?.isChunked) {
		logger.warn('No dashboard data reference found', {
			dashboardId: this._id,
		});
		return [];
	}
	const gfs = new GridFSBucket(mongoose.connection.db, {
		bucketName: 'Uploads',
	});
	try {
		const downloadStream = gfs.openDownloadStream(
			new mongoose.Types.ObjectId(this.dashboardDataRef.fileId)
		);
		let data = '';
		for await (const chunk of downloadStream) {
			data += chunk.toString('utf8');
		}
		return JSON.parse(data);
	} catch (err) {
		logger.error('Error retrieving dashboard data from GridFS', {
			dashboardId: this._id,
			fileId: this.dashboardDataRef.fileId,
			error: err.message,
		});
		return []; // Return empty array instead of throwing
	}
};

// Cache dashboard metadata
DashboardSchema.statics.cacheDashboardMetadata = async function (
	userId,
	dashboardId
) {
	try {
		const dashboard = await this.findById(dashboardId, {
			'dashboardDataRef.filename': 1,
			'dashboardDataRef.fileId': 1,
			files: 1,
		}).lean();

		if (!dashboard) {
			logger.warn('Dashboard not found for metadata caching', {
				dashboardId,
				userId,
			});
			return false;
		}

		const fileNames = new Set(
			[dashboard.dashboardDataRef?.filename].filter(Boolean)
		);
		const fileIds = new Set(
			[dashboard.dashboardDataRef?.fileId].filter(Boolean)
		);
		dashboard.files?.forEach((file) => {
			if (file.fileId && file.isChunked) {
				fileIds.add(file.fileId);
			}
		});

		const metadata = {
			fileNames: [...fileNames],
			fileIds: [...fileIds],
		};

		// Check metadata size before caching
		const metadataJson = JSON.stringify(metadata);
		const sizeInBytes = Buffer.byteLength(metadataJson, 'utf8');
		const MAX_CACHE_SIZE = 5 * 1024 * 1024; // 5MB threshold
		if (sizeInBytes > MAX_CACHE_SIZE) {
			logger.info('Metadata too large to cache', {
				userId,
				dashboardId,
				sizeInBytes,
				maxSize: MAX_CACHE_SIZE,
			});
			return false;
		}

		const wasCached = await setCachedDashboard(
			userId,
			`${dashboardId}:metadata`,
			metadata
		);
		if (!wasCached) {
			logger.info('Metadata too large to cache via setCachedDashboard', {
				userId,
				dashboardId,
				sizeInBytes,
			});
			return false;
		}

		logger.info('Cached dashboard metadata', {
			userId,
			dashboardId,
			fileCount: fileIds.size,
			sizeInBytes,
		});
		return true;
	} catch (err) {
		logger.error('Error caching dashboard metadata', {
			userId,
			dashboardId,
			error: err.message,
		});
		return false;
	}
};

// Get cached metadata
DashboardSchema.statics.getCachedMetadata = async function (
	userId,
	dashboardId
) {
	try {
		const metadata = await getCachedDashboard(
			userId,
			`${dashboardId}:metadata`
		);
		if (metadata) {
			logger.info('Redis cache hit for metadata', { userId, dashboardId });
		} else {
			logger.info('Redis cache miss for metadata', { userId, dashboardId });
		}
		return metadata;
	} catch (err) {
		logger.error('Error retrieving cached metadata', {
			userId,
			dashboardId,
			error: err.message,
		});
		return null;
	}
};

// Background job to delete GridFS files
deletionQueue.process(async (job) => {
	const { fileIds } = job.data;
	const gfs = new GridFSBucket(mongoose.connection.db, {
		bucketName: 'Uploads',
	});

	const BATCH_SIZE = 500;
	try {
		const fileObjectIds = fileIds.map((id) => new mongoose.Types.ObjectId(id));
		await mongoose.connection.db.collection('fs.files').deleteMany({
			_id: { $in: fileObjectIds },
		});
		await mongoose.connection.db.collection('fs.chunks').deleteMany({
			files_id: { $in: fileObjectIds },
		});
		logger.info('Completed GridFS deletion job', {
			jobId: job.id,
			fileCount: fileIds.length,
		});
	} catch (err) {
		logger.error('Error in GridFS deletion job', {
			jobId: job.id,
			error: err.message,
		});
		throw err;
	}
});

// Optimized deleteDashboardData
DashboardSchema.statics.deleteDashboardData = async function (
	dashboardId,
	userId
) {
	const start = Date.now();
	try {
		if (
			!mongoose.Types.ObjectId.isValid(dashboardId) ||
			!mongoose.Types.ObjectId.isValid(userId)
		) {
			logger.error('Invalid dashboardId or userId', { dashboardId, userId });
			throw new Error('Invalid dashboardId or userId');
		}

		const dashboard = await this.findOne(
			{ _id: dashboardId, userId },
			{
				'dashboardDataRef.fileId': 1,
				'dashboardDataRef.isChunked': 1,
				files: 1,
			}
		).lean();

		if (!dashboard) {
			logger.error('Dashboard not found', { dashboardId, userId });
			throw new Error('Dashboard not found');
		}

		const fileIds = [];
		if (
			dashboard.dashboardDataRef?.fileId &&
			dashboard.dashboardDataRef?.isChunked
		) {
			fileIds.push(dashboard.dashboardDataRef.fileId);
		}
		dashboard.files?.forEach((file) => {
			if (file.fileId && file.isChunked) {
				fileIds.push(file.fileId);
			}
		});

		const result = await this.updateOne(
			{ _id: dashboardId, userId },
			{ $set: { dashboardDataRef: null, files: [] } },
			{ writeConcern: { w: 0 } }
		);

		let queuedFiles = 0;
		if (fileIds.length > 0) {
			await deletionQueue.add(
				{ fileIds },
				{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }
			);
			queuedFiles = fileIds.length;
			logger.info('Queued GridFS deletions', {
				dashboardId,
				userId,
				fileCount: queuedFiles,
			});
		}

		await Promise.all([
			deleteCachedDashboard(userId, dashboardId),
			deleteCachedDashboard(userId, `${dashboardId}:metadata`),
		]);

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard data deletion completed', {
			dashboardId,
			userId,
			modifiedCount: result.modifiedCount,
			queuedFiles,
			duration,
		});

		return {
			modifiedCount: result.modifiedCount,
			queuedFiles,
			duration,
		};
	} catch (err) {
		logger.error('Error deleting dashboard data', {
			dashboardId,
			userId,
			error: err.message,
			stack: err.stack,
		});
		throw err;
	}
};

const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
