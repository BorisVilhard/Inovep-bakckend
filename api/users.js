import express from 'express';
import {
	getUser,
	updateUser,
	deleteUser,
	getAllUsers,
} from '../../controllers/usersController.js';
import {
	forgotPassword,
	verifyResetCode,
	resetPassword,
} from '../../controllers/forgotPassController.js';
import verifyJWT from '../../middleware/verifyJWT.js';

const router = express.Router();

router.post('/forgot-password', forgotPassword);

router.post('/verify-code', verifyResetCode);

router.post('/reset-password', resetPassword);

router.use(verifyJWT);

router.get('/', getAllUsers);

router.get('/:id', getUser);

router.put('/:id', updateUser);

router.delete('/:id', deleteUser);

export default router;
