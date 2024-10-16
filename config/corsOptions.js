export const corsOptions = {
	origin: (origin, callback) => {
		if (['http://localhost:3000'].indexOf(origin) !== -1 || !origin) {
			callback(null, true);
		} else {
			callback(new Error('Not allowed by CORS'));
		}
	},
	optionsSuccessStatus: 200,
};
