const credentials = (req, res, next) => {
	const origin = req.headers.origin;
	if (['http://localhost:3000'].includes(origin)) {
		res.header('Access-Control-Allow-Credentials', true);
	}
	next();
};

export default credentials;
