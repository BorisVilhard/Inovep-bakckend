const jwt = require('jsonwebtoken');

const verifyJWT = (req, res, next) => {
	const token = req.cookies.jwt || req.headers.authorization.split(' ')[1];
	if (!token) {
		return res.sendStatus(401);
	}

	jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decodedToken) => {
		if (err) {
			return res.sendStatus(403);
		}
		req.user = decodedToken;
		next();
	});
};

module.exports = verifyJWT;
