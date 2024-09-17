import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { corsOptions } from './config/corsOptions.js';
import { logger } from './middleware/logEvents.js';
import errorHandler from './middleware/errorHandler.js';
import verifyJWT from './middleware/verifyJWT.js';
import cookieParser from 'cookie-parser';
import credentials from './middleware/credentials.js';
import mongoose from 'mongoose';
import connectDB from './config/dbConn.js';
import rootRoutes from './routes/root.js';
import registerRoutes from './routes/register.js';
import authRoutes from './routes/auth.js';
import refreshRoutes from './routes/refresh.js';
import logoutRoutes from './routes/logout.js';
import bodyParser from 'body-parser';
import chatRoute from './routes/chat.js';
import userRoutes from './routes/api/users.js';
import documentProcessRoutes from './routes/documentProcess.js';

// Obtain __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3500;
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Connect to MongoDB
connectDB();

// Custom middleware logger
app.use(logger);
// Handle options credentials check - before CORS!
// and fetch cookies credentials requirement
app.use(credentials);

// Cross Origin Resource Sharing
app.use(cors(corsOptions));

// Built-in middleware to handle urlencoded form data
app.use(express.urlencoded({ extended: false }));

// Built-in middleware for JSON
app.use(express.json());

// Middleware for cookies
app.use(cookieParser());

// Serve static files
app.use('/', express.static(path.join(__dirname, '/public')));

// Routes

app.use('/', rootRoutes);
app.use('/register', registerRoutes);
app.use('/auth', authRoutes);
app.use('/refresh', refreshRoutes);
app.use('/logout', logoutRoutes);
app.use('/documentProcess', documentProcessRoutes);

// Use your upload route for /chat endpoint
app.use('/chat', chatRoute);

app.use(verifyJWT);
app.use('/users', userRoutes);

// Handle 404 errors
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

// Error handling middleware
app.use(errorHandler);

// Start server after connecting to MongoDB
mongoose.connection.once('open', () => {
	console.log('Connected to MongoDB');
	app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
