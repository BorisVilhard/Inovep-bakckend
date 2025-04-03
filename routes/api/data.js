// routes/api/data.js

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
	processFile,
	addCombinedChart,
	deleteCombinedChart,
	updateCombinedChart,
	processCloudText,
	uploadCloudData,
	checkAndUpdateMonitoredFiles,
} from '../../controllers/dataController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

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

router.post(
	'/users/:id/dashboard/upload',
	verifyUserOwnership,
	upload.single('file'),
	createOrUpdateDashboard
);

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

// Route to process a file (similar to upload) for local checking
router.post(
	'/users/:id/dashboard/:dashboardId/processFile',
	verifyUserOwnership,
	upload.single('file'),
	processFile
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

// routes/api/data.js
router.get(
	'/users/:id/dashboard/:dashboardId/check-monitored-files',
	verifyUserOwnership,
	checkAndUpdateMonitoredFiles
);

export default router;
