// verifyJWT.js
import jwt from 'jsonwebtoken';

const verifyJWT = (req, res, next) => {
	const authHeader = req.headers.authorization || req.headers.Authorization;

	if (!authHeader?.startsWith('Bearer ')) {
		console.log('No auth header or incorrect format');
		return res.status(401).json({ message: 'Unauthorized' });
	}

	const token = authHeader.split(' ')[1];

	jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
		if (err) {
			console.log('Token verification error:', err);
			return res.status(403).json({ message: 'Forbidden' });
		}
		console.log('Decoded Token:', decoded);
		req.user = decoded.UserInfo;
		next();
	});
};

export default verifyJWT;
