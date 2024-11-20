// routes/dashboardRoutes.js

import express from 'express';
import multer from 'multer';
import {
	getAllDashboards,
	getDashboardById,
	createOrUpdateDashboard,
	updateDashboard,
	deleteDashboard,
	deleteDataByFileName,
	verifyUserOwnership,
	getDashboardFiles,
	createDashboard,
	updateChartType,
	updateCategoryData,
	processFile,
	addCombinedChart,
	deleteCombinedChart,
	updateCombinedChart,
} from '../../controllers/dataController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();

const upload = multer({ dest: 'uploads/' });

// Apply JWT verification middleware to all routes
router.use(verifyJWT);

// Route to get all dashboards for a user
router.route('/users/:id/dashboard').get(verifyUserOwnership, getAllDashboards);

// Route to create a new dashboard
router.post(
	'/users/:id/dashboard/create',
	verifyUserOwnership,
	createDashboard
);

// Route to upload a file and create or update a dashboard
router.post(
	'/users/:id/dashboard/upload',
	verifyUserOwnership,
	upload.single('file'),
	createOrUpdateDashboard
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

// Route to process a file (similar to upload)
router.post(
	'/users/:id/dashboard/processFile',
	verifyUserOwnership,
	upload.single('file'),
	processFile
);

// **New Routes for CombinedChart Management**

// Route to add a CombinedChart to a DashboardCategory
router.post(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart',
	verifyUserOwnership,
	addCombinedChart
);

// Route to delete a CombinedChart from a DashboardCategory
router.delete(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId',
	verifyUserOwnership,
	deleteCombinedChart
);

// Route to update a CombinedChart in a DashboardCategory
router.put(
	'/users/:id/dashboard/:dashboardId/category/:categoryId/combinedChart/:combinedChartId',
	verifyUserOwnership,
	updateCombinedChart
);

export default router;
