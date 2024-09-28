import express from 'express';
import multer from 'multer';
import { uploadFile } from '../controllers/documentProcessController.js';

const router = express.Router();

const upload = multer({
	dest: './uploads',
	limits: { fileSize: 10 * 1024 * 1024 },
});

router.post('/', upload.single('file'), uploadFile);

export default router;
