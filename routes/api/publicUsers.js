import express from 'express';
import {
	verifyResetCode,
	resetPassword,
} from '../../controllers/usersController.js';

import { forgotPassword } from '../../controllers/forgotPassController.js';

const publicUsersRouter = express.Router();

publicUsersRouter.post('/forgot-password', forgotPassword);
publicUsersRouter.post('/verify-code', verifyResetCode);
publicUsersRouter.post('/reset-password', resetPassword);

export default publicUsersRouter;
