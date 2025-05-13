export class CustomError extends Error {
	constructor(statusCode = 500, message = 'Internal Server Error') {
		super(message);
		this.statusCode = statusCode;
		this.name = 'CustomError';
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, CustomError);
		}
	}
}
