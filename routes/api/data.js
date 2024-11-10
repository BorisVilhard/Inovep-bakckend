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
} from '../../controllers/dataController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();

const upload = multer({ dest: 'uploads/' });

router.use(verifyJWT);

router.route('/users/:id/dashboard').get(verifyUserOwnership, getAllDashboards);

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

router.get(
	'/users/:id/dashboard/:dashboardId/files',
	verifyUserOwnership,
	getDashboardFiles
);

router
	.route('/users/:id/dashboard/:dashboardId')
	.get(verifyUserOwnership, getDashboardById)
	.put(verifyUserOwnership, updateDashboard)
	.delete(verifyUserOwnership, deleteDashboard);

router.put(
	'/users/:id/dashboard/:dashboardId/chart/:chartId',
	verifyUserOwnership,
	updateChartType
);

router.put(
	'/users/:id/dashboard/:dashboardId/category/:categoryName',
	verifyUserOwnership,
	updateCategoryData
);

router.delete(
	'/users/:id/dashboard/:dashboardId/file/:fileName',
	verifyUserOwnership,
	deleteDataByFileName
);

router.post(
	'/users/:id/dashboard/processFile',
	verifyUserOwnership,
	upload.single('file'),
	processFile
);

export default router;
