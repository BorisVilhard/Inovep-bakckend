import dotenv from 'dotenv';
dotenv.config();
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
import dataProcessingRoutes from './routes/api/dataProcessing.js';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import bodyParser from 'body-parser';
import authRoutes from './routes/auth.js';
import monitorRoutes from './routes/monitor.js';
import winston from 'winston';

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Set Mongoose strictQuery to suppress deprecation warning
mongoose.set('strictQuery', true);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Winston logger for server errors
const serverLogger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json()
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({ filename: 'error.log', level: 'error' }),
		new winston.transports.File({ filename: 'combined.log' }),
	],
});

// Middleware setup
app.use((req, res, next) => {
	serverLogger.info('Incoming request', {
		method: req.method,
		url: req.url,
		ip: req.ip,
	});
	next();
});
app.use(logger); // Custom request logger
app.use(credentials); // Handle CORS credentials
app.use(cors(corsOptions)); // Apply CORS with configured options
app.use(compression()); // Compress responses
app.use(bodyParser.json()); // Parse JSON bodies
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(express.static(path.join(__dirname, 'views'))); // Serve static files (e.g., 404.html)

// Socket.io setup
const io = new Server(server, {
	cors: {
		origin: process.env.FRONTEND_URL || 'http://localhost:3000',
		methods: ['GET', 'POST'],
		credentials: true,
	},
});
app.set('io', io); // Make io accessible in routes/controllers

io.on('connection', (socket) => {
	serverLogger.info('A user connected', { socketId: socket.id });

	// Join dashboard-specific room
	socket.on('join-dashboard', ({ userId, dashboardId }) => {
		const room = `dashboard:${userId}:${dashboardId}`;
		socket.join(room);
		serverLogger.info('Socket joined dashboard room', {
			socketId: socket.id,
			room,
		});
	});

	// Handle disconnect
	socket.on('disconnect', () => {
		serverLogger.info('User disconnected', { socketId: socket.id });
	});

	// Handle socket errors
	socket.on('error', (err) => {
		serverLogger.error('Socket error', {
			socketId: socket.id,
			error: err.message,
		});
	});
});

// Routes (public)
app.use('/', rootRoutes);
app.use('/auth', authRoutes);
app.use('/register', registerRoutes);
app.use('/refresh', refreshRoutes);
app.use('/logout', logoutRoutes);
app.use('/chat', chatRoute);
app.use('/dataProcess', dataProcessingRoutes);

app.use('/api/monitor', monitorRoutes);

// Routes (mixed access)
app.use('/users', userRoutes); // May have public and protected endpoints

// Protected routes
app.use(verifyJWT);
app.use('/data', dataRoutes);

// Root test endpoint
app.get('/', (req, res) => {
	res.send('Google Drive Folder & File Monitor with Socket.io');
});

// Catch-all for 404 errors
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

// Error handler (must be last)
app.use(errorHandler);

// Connect to MongoDB and start server
const PORT = process.env.PORT || 3500;
connectDB()
	.then(() => {
		server.listen(PORT, () => {
			serverLogger.info(`Server running on port ${PORT}`);
			console.log(`Server running on port ${PORT}`);
		});
	})
	.catch((error) => {
		serverLogger.error('Failed to connect to MongoDB', {
			error: error.message,
		});
		console.error('Failed to connect to MongoDB:', error);
		process.exit(1);
	});
