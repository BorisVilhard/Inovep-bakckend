import mongoose from 'mongoose';
import { GridFSBucket } from 'mongodb';
import Queue from 'bull';
import winston from 'winston';
import zlib from 'zlib';
import {
	setCachedDashboard,
	getCachedDashboard,
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

// Schema for individual entries
const EntrySchema = new mongoose.Schema(
	{
		t: { type: String, required: true, trim: true, maxlength: 100 }, // title
		v: { type: mongoose.Schema.Types.Mixed, required: true }, // value
		d: { type: Date, required: true }, // date
	},
	{ _id: false }
);

// Schema for indexed entries
const IndexedEntriesSchema = new mongoose.Schema(
	{
		i: { type: String, required: true, trim: true, maxlength: 100 }, // id
		d: {
			type: [EntrySchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'Data array cannot be empty'],
		}, // data
	},
	{ _id: false }
);

// Schema for combined charts
const CombinedChartSchema = new mongoose.Schema(
	{
		i: {
			type: String,
			required: true,
			unique: true,
			trim: true,
			maxlength: 100,
		}, // id
		c: {
			type: [String],
			required: true,
			validate: [(arr) => arr.length >= 2, 'At least two chartIds required'],
		}, // chartIds
		d: {
			type: [EntrySchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'Data array cannot be empty'],
		}, // data
	},
	{ _id: false }
);

// Schema for dashboard categories
const DashboardCategorySchema = new mongoose.Schema(
	{
		cat: { type: String, required: true, trim: true, maxlength: 100 }, // categoryName
		data: {
			type: [IndexedEntriesSchema],
			required: true,
			validate: [(arr) => arr.length > 0, 'Data array cannot be empty'],
		}, // mainData
		comb: { type: [CombinedChartSchema], default: [] }, // combinedData
		sum: { type: [EntrySchema], default: [] }, // summaryData
		chart: { type: String }, // appliedChartType
		ids: { type: [String], default: [] }, // checkedIds
	},
	{ _id: false }
);

// Schema for file data
const FileDataSchema = new mongoose.Schema(
	{
		fid: { type: String, trim: true }, // fileId
		fn: { type: String, required: true, trim: true, maxlength: 255 }, // filename
		c: { type: Buffer }, // content
		lu: { type: Date, default: Date.now }, // lastUpdate
		src: { type: String, enum: ['local', 'google'], default: 'local' }, // source
		ch: { type: Boolean, default: false }, // isChunked
		cc: { type: Number, default: 1, min: 1 }, // chunkCount
		mon: {
			s: { type: String, enum: ['active', 'expired'], default: 'active' }, // status
			ed: { type: Date }, // expireDate
			f: { type: String, default: null, trim: true, maxlength: 100 }, // folderId
		},
	},
	{ _id: true }
);

// Schema for dashboard data reference
const DashboardDataRefSchema = new mongoose.Schema(
	{
		fid: { type: String, required: true, trim: true }, // fileId
		fn: { type: String, required: true, trim: true, maxlength: 255 }, // filename
		ch: { type: Boolean, default: true }, // isChunked
		cc: { type: Number, default: 1, min: 1 }, // chunkCount
		lu: { type: Date, default: Date.now }, // lastUpdate
	},
	{ _id: false }
);

// Dashboard Schema
const DashboardSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			required: true,
			trim: true,
			maxlength: 100,
			index: true,
		}, // dashboardName
		ref: { type: DashboardDataRefSchema, default: null }, // dashboardDataRef
		f: [FileDataSchema], // files
		uid: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		}, // userId
		ca: { type: Date, default: Date.now }, // createdAt
		ua: { type: Date, default: Date.now }, // updatedAt
		da: { type: Date, default: null }, // deletedAt
	},
	{
		timestamps: { createdAt: 'ca', updatedAt: 'ua' },
		versionKey: false,
	}
);

// Indexes
DashboardSchema.index({ uid: 1, _id: 1 });
DashboardSchema.index({ uid: 1, name: 1 });
DashboardSchema.index({ 'f.fn': 1 });
DashboardSchema.index({ 'ref.fn': 1 });
DashboardSchema.index(
	{ 'f.mon.s': 1, 'f.mon.ed': 1 },
	{ partialFilterExpression: { 'f.mon.s': 'expired' } }
);

// Pre-save middleware
DashboardSchema.pre('save', function (next) {
	this.ua = new Date();
	next();
});

// Pre-remove middleware
DashboardSchema.pre('remove', async function (next) {
	try {
		const gfs = new GridFSBucket(mongoose.connection.db, {
			bucketName: 'Uploads',
		});
		const fileIds = [];
		if (this.ref?.fid && this.ref?.ch) {
			fileIds.push(new mongoose.Types.ObjectId(this.ref.fid));
		}
		this.f
			.filter((file) => file.fid && file.ch)
			.forEach((file) => fileIds.push(new mongoose.Types.ObjectId(file.fid)));

		if (fileIds.length > 0) {
			await deletionQueue.add({ fileIds }, { attempts: 3 });
			logger.info('Queued GridFS deletions for dashboard removal', {
				dashboardId: this._id.toString(),
				fileCount: fileIds.length,
			});
		}
		next();
	} catch (err) {
		logger.error('Error in pre-remove middleware', {
			dashboardId: this._id.toString(),
			error: err.message,
		});
		next(err);
	}
});

// Retrieve dashboard data from GridFS, decompressing if needed
DashboardSchema.methods.getDashboardData = async function () {
	if (!this.ref?.fid || !this.ref?.ch) {
		logger.warn('No dashboard data reference found', {
			dashboardId: this._id.toString(),
		});
		return [];
	}
	const gfs = new GridFSBucket(mongoose.connection.db, {
		bucketName: 'Uploads',
	});
	try {
		const downloadStream = gfs.openDownloadStream(
			new mongoose.Types.ObjectId(this.ref.fid)
		);
		let chunks = [];
		for await (const chunk of downloadStream) {
			chunks.push(chunk);
		}
		const data = Buffer.concat(chunks);

		let json;
		if (data.length < 100 && data.toString('utf8').startsWith('{')) {
			json = data.toString('utf8'); // Uncompressed (small files)
		} else {
			try {
				json = zlib.gunzipSync(data).toString('utf8'); // Compressed
			} catch (e) {
				logger.warn('Data not compressed, trying raw', {
					dashboardId: this._id.toString(),
				});
				json = data.toString('utf8');
			}
		}

		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) {
			logger.error('Invalid dashboard data format', {
				dashboardId: this._id.toString(),
			});
			return [];
		}
		return parsed;
	} catch (err) {
		logger.error('Error retrieving dashboard data from GridFS', {
			dashboardId: this._id.toString(),
			fileId: this.ref.fid,
			error: err.message,
		});
		return [];
	}
};

// Cache dashboard metadata
DashboardSchema.statics.cacheDashboardMetadata = async function (uid, id) {
	if (
		!mongoose.Types.ObjectId.isValid(uid) ||
		!mongoose.Types.ObjectId.isValid(id)
	) {
		logger.error('Invalid uid or id', { uid, id });
		return false;
	}
	try {
		const dashboard = await this.findById(id, {
			'ref.fn': 1,
			'ref.fid': 1,
			f: 1,
		}).lean();

		if (!dashboard) {
			logger.warn('Dashboard not found for metadata caching', { id, uid });
			return false;
		}

		const fileNames = new Set([dashboard.ref?.fn].filter(Boolean));
		const fileIds = new Set([dashboard.ref?.fid].filter(Boolean));
		dashboard.f?.forEach((file) => {
			if (file.fid && file.ch) fileIds.add(file.fid);
		});

		const metadata = {
			fileNames: [...fileNames],
			fileIds: [...fileIds],
		};

		const metadataJson = JSON.stringify(metadata);
		const sizeInBytes = Buffer.byteLength(metadataJson, 'utf8');
		const MAX_CACHE_SIZE = 5 * 1024 * 1024;
		if (sizeInBytes > MAX_CACHE_SIZE) {
			logger.info('Metadata too large to cache', {
				uid,
				id,
				sizeInBytes,
				maxSize: MAX_CACHE_SIZE,
			});
			return false;
		}

		const wasCached = await setCachedDashboard(uid, `${id}:meta`, metadata);
		if (!wasCached) {
			logger.info('Metadata too large to cache via setCachedDashboard', {
				uid,
				id,
				sizeInBytes,
			});
			return false;
		}

		logger.info('Cached dashboard metadata', {
			uid,
			id,
			fileCount: fileIds.size,
			sizeInBytes,
		});
		return true;
	} catch (err) {
		logger.error('Error caching dashboard metadata', {
			uid,
			id,
			error: err.message,
		});
		return false;
	}
};

// Get cached metadata
DashboardSchema.statics.getCachedMetadata = async function (uid, id) {
	if (
		!mongoose.Types.ObjectId.isValid(uid) ||
		!mongoose.Types.ObjectId.isValid(id)
	) {
		logger.error('Invalid uid or id', { uid, id });
		return null;
	}
	try {
		const metadata = await getCachedDashboard(uid, `${id}:meta`);
		if (metadata) {
			logger.info('Redis cache hit for metadata', { uid, id });
		} else {
			logger.info('Redis cache miss for metadata', { uid, id });
		}
		return metadata;
	} catch (err) {
		logger.error('Error retrieving cached metadata', {
			uid,
			id,
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

	try {
		const fileObjectIds = fileIds.map((id) => new mongoose.Types.ObjectId(id));
		await Promise.all([
			mongoose.connection.db.collection('fs.files').deleteMany({
				_id: { $in: fileObjectIds },
			}),
			mongoose.connection.db.collection('fs.chunks').deleteMany({
				files_id: { $in: fileObjectIds },
			}),
		]);
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
DashboardSchema.statics.deleteDashboardData = async function (id, uid) {
	const start = Date.now();
	try {
		if (
			!mongoose.Types.ObjectId.isValid(id) ||
			!mongoose.Types.ObjectId.isValid(uid)
		) {
			logger.error('Invalid id or uid', { id, uid });
			throw new Error('ERR_INVALID_ID: Invalid id or uid');
		}

		const dashboard = await this.findOne(
			{ _id: id, uid },
			{ 'ref.fid': 1, 'ref.ch': 1, f: 1 }
		).lean();

		if (!dashboard) {
			logger.error('Dashboard not found', { id, uid });
			throw new Error('ERR_NOT_FOUND: Dashboard not found');
		}

		const fileIds = [];
		if (dashboard.ref?.fid && dashboard.ref?.ch) {
			fileIds.push(dashboard.ref.fid);
		}
		dashboard.f?.forEach((file) => {
			if (file.fid && file.ch) fileIds.push(file.fid);
		});

		const result = await this.updateOne(
			{ _id: id, uid },
			{ $set: { ref: null, f: [] } },
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
				id,
				uid,
				fileCount: queuedFiles,
			});
		}

		await Promise.all([
			deleteCachedDashboard(uid, id),
			deleteCachedDashboard(uid, `${id}:meta`),
		]);

		const duration = (Date.now() - start) / 1000;
		logger.info('Dashboard data deletion completed', {
			id,
			uid,
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
			id,
			uid,
			error: err.message,
		});
		throw err;
	}
};

const Dashboard = mongoose.model('Dashboard', DashboardSchema);
export default Dashboard;
