// socket.js

import { Server } from 'socket.io';

/**
 * Initializes and configures the Socket.io server.
 *
 * @param {http.Server} server - The HTTP server instance.
 * @param {Object} options - Configuration options.
 * @param {Express.Application} options.app - The Express app instance.
 * @param {string|string[]} [options.corsOrigin="*"] - Allowed origin(s) for CORS.
 * @returns {SocketIO.Server} - The initialized Socket.io server instance.
 */
function setupSocket(server, options = {}) {
	const { app, corsOrigin = '*' } = options;

	// Initialize Socket.io server with CORS settings
	const io = new Server(server, {
		cors: {
			origin: corsOrigin, // e.g., "http://localhost:3000"
			methods: ['GET', 'POST'],
		},
		// Optional: Adjust other Socket.io settings as needed
	});

	// Attach the io instance to the Express app for access in controllers
	if (app) {
		app.set('io', io);
	}

	// Handle client connections
	io.on('connection', (socket) => {
		console.log(`New client connected: ${socket.id}`);

		/**
		 * Event: 'join-file'
		 * Description: Allows a client to join a room corresponding to a specific fileId.
		 * Payload: { fileId: string }
		 */
		socket.on('join-file', (fileId) => {
			if (fileId && typeof fileId === 'string') {
				socket.join(fileId);
				console.log(`Socket ${socket.id} joined room: ${fileId}`);
				socket.emit('joined-file', { fileId });
			} else {
				console.warn(`Invalid fileId provided by socket ${socket.id}:`, fileId);
				socket.emit('error', { message: 'Invalid fileId for joining room.' });
			}
		});

		/**
		 * Event: 'leave-file'
		 * Description: Allows a client to leave a room corresponding to a specific fileId.
		 * Payload: { fileId: string }
		 */
		socket.on('leave-file', (fileId) => {
			if (fileId && typeof fileId === 'string') {
				socket.leave(fileId);
				console.log(`Socket ${socket.id} left room: ${fileId}`);
				socket.emit('left-file', { fileId });
			} else {
				console.warn(`Invalid fileId provided by socket ${socket.id}:`, fileId);
				socket.emit('error', { message: 'Invalid fileId for leaving room.' });
			}
		});

		/**
		 * Handle client disconnection
		 */
		socket.on('disconnect', (reason) => {
			console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
		});

		/**
		 * Optional: Handle other custom events as needed
		 */
	});

	/**
	 * Optional: Middleware for authenticating Socket.io connections
	 * Uncomment and customize the following block if authentication is required
	 */
	/*
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (isValidToken(token)) {
      return next();
    }
    return next(new Error("Authentication error"));
  });
  */

	return io;
}

export default setupSocket;
