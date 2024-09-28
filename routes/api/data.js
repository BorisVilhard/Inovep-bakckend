// routes/dataRoutes.js

import express from 'express';
import {
	getAllData,
	getData,
	createData,
	updateData,
	deleteDashboard,
	deleteCategory,
	deleteChart,
} from '../../controllers/dataController.js';

const router = express.Router();

router.get('/', getAllData);
router.get('/:id', getData);
router.post('/', createData);
router.put('/:id', updateData);

// Delete operations
router.delete('/:id', deleteDashboard); // Delete a dashboard
router.delete('/:id/category/:categoryName', deleteCategory); // Delete a category
router.delete('/:id/category/:categoryName/chart/:chartId', deleteChart); // Delete a chart

export default router;
