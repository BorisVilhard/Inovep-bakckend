import express from 'express';
import {
	getUser,
	updateUser,
	deleteUser,
	getAllUsers,
} from '../../controllers/usersController.js';

const router = express.Router();

// Improved route definitions
router.route('/').get(getAllUsers);

// Assuming a POST method for creating a user
router.route('/:id').get(getUser).put(updateUser).delete(deleteUser);

export default router;
