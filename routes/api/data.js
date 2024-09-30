import express from 'express';
import {
	getAllDashboards,
	getDashboardById,
	createDashboard,
	updateDashboard,
	deleteDashboard,
	verifyUserOwnership,
} from '../../controllers/dataController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();

router.use(verifyJWT);

router
	.route('/users/:id/dashboard')
	.get(verifyUserOwnership, getAllDashboards)
	.post(verifyUserOwnership, createDashboard);

router
	.route('/users/:id/dashboard/:dashboardId')
	.get(verifyUserOwnership, getDashboardById)
	.put(verifyUserOwnership, updateDashboard)
	.delete(verifyUserOwnership, deleteDashboard);

export default router;
