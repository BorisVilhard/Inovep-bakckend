import express from 'express';
import {
	getAllData,
	getData,
	createData,
	updateData,
	deleteData,
} from '../controllers/dataController.js';

const router = express.Router();

router.get('/', getAllData);
router.get('/:id', getData);
router.post('/', createData);
router.put('/:id', updateData);
router.delete('/:id', deleteData);

export default router;
