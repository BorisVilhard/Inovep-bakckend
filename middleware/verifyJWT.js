// verifyJWT.js
import jwt from 'jsonwebtoken';

const verifyJWT = (req, res, next) => {
	// Get the authorization header
	const authHeader = req.headers['authorization'];

	// Check if the header is not undefined and starts with 'Bearer'
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return res.status(401).json({
			message: 'Authorization header missing or improperly formatted',
		});
	}

	// Extract the token
	const token = authHeader.split(' ')[1]; // This will handle properly formatted 'Bearer token'

	// Verify the token
	jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
		if (err) {
			return res.status(403).json({ message: 'Failed to authenticate token' });
		}
		req.user = decoded; // Assuming the decoded token contains user info
		next();
	});
};

export default verifyJWT;
