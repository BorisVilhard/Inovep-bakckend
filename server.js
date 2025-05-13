import dotenv from 'dotenv';
dotenv.config();
import 'dotenv/config';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import { corsOptions } from './config/corsOptions.js';
import { logger } from './middleware/logEvents.js';
import errorHandler from './middleware/errorHandler.js';
import verifyJWT from './middleware/verifyJWT.js';
import credentials from './middleware/credentials.js';
import mongoose from 'mongoose';
import connectDB from './config/dbConn.js';
import rootRoutes from './routes/root.js';
import registerRoutes from './routes/register.js';
import refreshRoutes from './routes/refresh.js';
import logoutRoutes from './routes/logout.js';
import chatRoute from './routes/chat.js';
import userRoutes from './routes/api/users.js';
import dataRoutes from './routes/api/data.js';
// Import necessary modules
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
// Import route handlers
import authRoutes from './routes/auth.js';
import monitorRoutes from './routes/monitor.js';

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

connectDB();

app.use(logger);
app.use(credentials);
app.use(compression());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(errorHandler);
app.use(express.urlencoded({ extended: false }));

const io = new Server(server, {
	cors: {
		origin: process.env.FRONTEND_URL || 'http://localhost:3000',
		methods: ['GET', 'POST'],
		credentials: true,
	},
});

// Make io accessible in other modules
app.set('io', io);

// 2) Handle Socket.io connections
io.on('connection', (socket) => {
	console.log('A user connected:', socket.id);

	// Optionally let clients join a room for a file ID
	socket.on('join-file', (fileId) => {
		socket.join(fileId);
		console.log(`Socket ${socket.id} joined room: ${fileId}`);
	});

	socket.on('disconnect', () => {
		console.log('User disconnected:', socket.id);
	});
});

// 3) Middleware
app.use(express.json());
app.use(cors(corsOptions));
app.use('/', rootRoutes);
// 4) Routes
app.use('/auth', authRoutes);
app.use('/api/monitor', monitorRoutes); // Final routes: /api/monitor/folder, /api/monitor/notifications, etc.

app.use('/register', registerRoutes);
app.use('/refresh', refreshRoutes);
app.use('/logout', logoutRoutes);
app.use('/chat', chatRoute);
app.use('/users', userRoutes);

app.use(verifyJWT);
app.use('/data', dataRoutes);

// 5) Root test endpoint
app.get('/', (req, res) => {
	res.send('Google Drive Folder & File Monitor with Socket.io');
});

app.all('*', (req, res) => {
	res.status(404);
	if (req.accepts('html')) {
		res.sendFile(path.join(__dirname, 'views', '404.html'));
	} else if (req.accepts('json')) {
		res.json({ error: '404 Not Found' });
	} else {
		res.type('txt').send('404 Not Found');
	}
});

const PORT = 3500;

server.listen(PORT, () => {
	console.log(`Server running on port ${PORT}`);
});

// mongoose.connection.once('open', () => {
// 	console.log('Connected to MongoDB');
// 	app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// });
