import express from 'express';
import multer from 'multer';
import winston from 'winston';
import {
	createOrUpdateDashboard,
	deleteDashboardData,
	getDashboardData,
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

// Configure Multer for in-memory file uploads (no local storage)
const upload = multer({
	storage: multer.memoryStorage(), // Store files in-memory as buffers
	limits: {
		fileSize: 6 * 1024 * 1024, // 6MB limit to prevent oversized processed data
		fieldSize: 1 * 1024 * 1024, // 1MB for form fields
	},
	fileFilter: (req, file, cb) => {
		const allowedMimeTypes = [
			'text/csv',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
			'application/vnd.ms-excel', // .xls
			'application/octet-stream', // Fallback for .xlsx
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
			message:
				err.message === 'File too large'
					? 'File size exceeds 6MB limit'
					: 'File upload error',
		});
	} else if (err) {
		logger.error('File validation error', {
			error: err.message,
			userId: req.params.userId,
		});
		return res.status(400).json({ message: err.message });
	}
	next();
};

// Create or update dashboard with CSV or Excel file upload
router.post(
	'/users/:userId/dashboard/upload',
	upload.single('file'),
	handleMulterError,
	createOrUpdateDashboard
);

// Retrieve dashboard data
router.get('/users/:userId/dashboard/:dashboardId', getDashboardData);

// Delete dashboard data
router.delete('/users/:userId/dashboard/:dashboardId', deleteDashboardData);

export default router;
