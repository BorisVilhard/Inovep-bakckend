import User from '../model/User.js';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const handleGoogleAuth = async (req, res) => {
	const { token } = req.body;

	if (!token) {
		return res.status(400).json({ message: 'Google token is required.' });
	}

	try {
		const ticket = await client.verifyIdToken({
			idToken: token,
			audience: process.env.GOOGLE_CLIENT_ID,
		});

		const payload = ticket.getPayload();

		if (!payload) {
			return res.status(400).json({ message: 'Invalid Google token.' });
		}

		const { sub: googleId, email, name } = payload;

		let user = await User.findOne({ email });

		if (user) {
			// If user exists but hasn't used Google OAuth
			if (!user.googleId) {
				console.log(
					`Existing user with email ${email} attempted Google OAuth.`
				);
				return res.status(400).json({
					message:
						'Email already in use. Please log in with your email and password or link your Google account.',
				});
			}
		} else {
			// Create a new user
			user = await User.create({
				username: name,
				email,
				googleId,
			});
			console.log(`New user registered via Google: ${email}`);
		}

		// Generate JWT tokens
		const accessToken = jwt.sign(
			{
				UserInfo: {
					id: user._id,
					username: user.username,
					email: user.email,
				},
			},
			process.env.ACCESS_TOKEN_SECRET,
			{ expiresIn: '1d' }
		);

		const refreshToken = jwt.sign(
			{ username: user.username },
			process.env.REFRESH_TOKEN_SECRET,
			{ expiresIn: '1d' }
		);

		// Save refresh token in DB
		user.refreshToken = refreshToken;
		await user.save();

		// Set refresh token in HTTP-only cookie
		res.cookie('jwt', refreshToken, {
			httpOnly: true,
			secure: process.env.NODE_ENV === 'production', // Ensure HTTPS in production
			sameSite: 'None', // Adjust based on your requirements
			maxAge: 24 * 60 * 60 * 1000, // 1 day
		});

		console.log(`User logged in via Google: ${email}`);

		res.status(200).json({
			id: user._id,
			username: user.username,
			email: user.email,
			accessToken,
		});
	} catch (error) {
		console.error('Google authentication error:', error);
		res
			.status(500)
			.json({ message: 'Internal Server Error', error: error.message });
	}
};
