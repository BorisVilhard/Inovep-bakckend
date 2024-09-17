import express from 'express';
import multer from 'multer';
import { uploadFile } from '../controllers/documentProcessController.js';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
	dest: './uploads',
	limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB limit
});

// Define the POST route for document processing
router.post('/', upload.single('file'), uploadFile);

export default router;
