import express from 'express';
import multer from 'multer';
import {
	getAllDashboards,
	getDashboardById,
	createDashboard,
	createOrUpdateDashboard,
	updateDashboard,
	deleteDashboard,
	deleteDataByFileName,
	verifyUserOwnership,
	getDashboardFiles,
	updateChartType,
	updateCategoryData,
	addCombinedChart,
	deleteCombinedChart,
	updateCombinedChart,
	processCloudText,
	uploadCloudData,
	checkAndUpdateMonitoredFiles,
	uploadChunk,
	finalizeChunk,
} from '../../controllers/dataController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // Use memory storage

// Apply JWT verification middleware to all routes
router.use(verifyJWT);

// Route to get all dashboards for a user
router.get('/users/:id/dashboard', verifyUserOwnership, getAllDashboards);

// Route to create a new dashboard
router.post(
	'/users/:id/dashboard/create',
	verifyUserOwnership,
	createDashboard
);

// Route for single-file upload
router.post(
	'/users/:id/dashboard/upload',
	verifyUserOwnership,
	upload.single('file'),
	createOrUpdateDashboard
);

// Route for chunked file upload
router.post(
	'/users/:id/dashboard/upload-chunk',
	verifyUserOwnership,
	upload.single('chunk'),
	uploadChunk
);

// Route to finalize chunked upload
router.post(
	'/users/:id/dashboard/finalize-chunk',
	verifyUserOwnership,
	finalizeChunk
);

// Route to process cloud text data
router.post(
	'/users/:id/dashboard/:dashboardId/cloudText',
	verifyUserOwnership,
	processCloudText
);

// Route to upload processed cloud data
router.post(
	'/users/:id/dashboard/uploadCloud',
	verifyUserOwnership,
	uploadCloudData
);

// Route to get all files associated with a dashboard
router.get(
	'/users/:id/dashboard/:dashboardId/files',
	verifyUserOwnership,
	getDashboardFiles
);

// Routes for specific dashboard operations
router
	.route('/users/:id/dashboard/:dashboardId')
	.get(verifyUserOwnership, getDashboardById)
	.put(verifyUserOwnership, updateDashboard)
	.delete(verifyUserOwnership, deleteDashboard);

// Route to update a specific chart's type
router.put(
	'/users/:id/dashboard/:dashboardId/chart/:chartId',
	verifyUserOwnership,
	updateChartType
);

// Route to update a specific category's data
router.put(
	'/users/:id/dashboard/:dashboardId/category/:categoryName',
	verifyUserOwnership,
	updateCategoryData
);

// Route to delete data associated with a specific fileName
router.delete(
	'/users/:id/dashboard/:dashboardId/file/:fileName',
	verifyUserOwnership,
	deleteDataByFileName
);

// CombinedChart routes
router.post(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart',
	verifyUserOwnership,
	addCombinedChart
);
router.delete(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId',
	verifyUserOwnership,
	deleteCombinedChart
);
router.put(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId',
	verifyUserOwnership,
	updateCombinedChart
);

// Route to check monitored files
router.get(
	'/users/:id/dashboard/:dashboardId/check-monitored-files',
	verifyUserOwnership,
	checkAndUpdateMonitoredFiles
);

export default router;
