import express from 'express';
import {
	getAllUsers,
	getUser,
	updateUser,
	deleteUser,
} from '../../controllers/usersController.js';
import {
	forgotPassword,
	verifyResetCode,
	resetPassword,
} from '../../controllers/forgotPassController.js';

const router = express.Router();

router.get('/', getAllUsers);
router.get('/:id', getUser);
router.patch('/:id', updateUser);
router.delete('/:id', deleteUser);

router.post('/forgot-password', forgotPassword);
router.post('/verify-code', verifyResetCode);
router.post('/reset-password', resetPassword);

export default router;
