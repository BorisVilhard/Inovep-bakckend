import express from 'express';
import multer from 'multer';
import winston from 'winston';
import {
	createOrUpdateDashboard,
	deleteDashboardData,
	getDashboardData,
	getAllDashboards,
	calculateDashboardParameters,
	getNumericTitlesEndpoint,
	getDateTitlesEndpoint,
} from '../../controllers/dataProcessingController.js';

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

const router = express.Router();

// Configure Multer for in-memory file uploads
const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: 6 * 1024 * 1024, // 6MB total file limit
		fieldSize: 1 * 1024 * 1024, // 1MB for form fields
	},
	fileFilter: (req, file, cb) => {
		const chunkIdx = parseInt(req.body.chunkIdx, 10);
		const isChunked = !isNaN(chunkIdx) && req.body.totalChunks;

		if (isChunked) {
			// Skip MIME type and extension validation for all chunks
			logger.info('Skipping file type validation for chunked upload', {
				filename: file.originalname,
				mimetype: file.mimetype,
				chunkIdx,
				fileSize: file.size,
				userId: req.params.userId,
			});
			cb(null, true);
			return;
		}

		const allowedMimeTypes = [
			'text/csv',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'application/vnd.ms-excel',
			'application/octet-stream',
		];
		const allowedExtensions = ['.csv', '.xlsx', '.xls'];
		const extension =
			file.originalname.toLowerCase().match(/\.[^\.]+$/)?.[0] || '';

		logger.info('File upload attempt', {
			filename: file.originalname,
			mimetype: file.mimetype,
			extension,
			fileSize: file.size,
			userId: req.params.userId,
		});

		if (
			allowedMimeTypes.includes(file.mimetype) &&
			allowedExtensions.includes(extension)
		) {
			cb(null, true);
		} else {
			logger.error('Unsupported file type', {
				filename: file.originalname,
				mimetype: file.mimetype,
				extension,
				fileSize: file.size,
				userId: req.params.userId,
			});
			cb(
				new Error('Only CSV and Excel (.csv, .xlsx, .xls) files are supported')
			);
		}
	},
});

// Handle Multer errors
const handleMulterError = (err, req, res, next) => {
	if (err instanceof multer.MulterError) {
		logger.error('Multer error during file upload', {
			error: err.message,
			code: err.code,
			field: err.field,
			userId: req.params.userId,
		});
		return res.status(400).json({
			msg:
				err.message === 'File too large'
					? 'File size exceeds 6MB limit'
					: 'File upload error',
		});
	} else if (err) {
		logger.error('File validation error', {
			error: err.message,
			userId: req.params.userId,
		});
		return res.status(400).json({ msg: err.message });
	}
	next();
};

// Routes
router.post(
	'/users/:userId/dashboard/upload',
	upload.single('file'),
	handleMulterError,
	createOrUpdateDashboard
);
router.post(
	'/users/:userId/dashboard/:dashboardId/calculate',
	calculateDashboardParameters
);
router.get(
	'/users/:userId/dashboard/:dashboardId/date-titles',
	getDateTitlesEndpoint
);
router.get('/users/:userId/dashboard/:dashboardId', getDashboardData);
router.delete('/users/:userId/dashboard/:dashboardId', deleteDashboardData);
router.get('/users/:userId/dashboards', getAllDashboards);
// router.put(
//   '/users/:userId/dashboard/:dashboardId/category/:categoryName',
//   updateCategoryData
// );
// router.get(
//   '/users/:userId/dashboard/:dashboardId/file/:fileId',
//   downloadDashboardFile
// );
router.get(
	'/users/:userId/dashboard/:dashboardId/numeric-titles',
	getNumericTitlesEndpoint
);

export default router;
