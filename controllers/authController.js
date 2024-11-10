import User from '../model/User.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

export const handleLogin = async (req, res) => {
	const { email, pwd } = req.body;

	if (!email || !pwd) {
		return res
			.status(400)
			.json({ message: 'Username and password are required.' });
	}

	try {
		const foundUser = await User.findOne({ email: email }).exec();
		if (!foundUser) return res.sendStatus(401);

		const match = await bcrypt.compare(pwd, foundUser.password);
		if (match) {
			const accessToken = jwt.sign(
				{
					UserInfo: {
						id: foundUser._id,
						username: foundUser.username,
						email: foundUser.email,
					},
				},
				process.env.ACCESS_TOKEN_SECRET,
				{ expiresIn: '1d' }
			);

			const refreshToken = jwt.sign(
				{ username: foundUser.username },
				process.env.REFRESH_TOKEN_SECRET,
				{ expiresIn: '1d' }
			);

			foundUser.refreshToken = refreshToken;
			await foundUser.save();

			res.cookie('jwt', refreshToken, {
				httpOnly: true,
				secure: true,
				sameSite: 'None',
				maxAge: 24 * 60 * 60 * 1000,
			});

			res.json({
				id: foundUser._id,
				username: foundUser.username,
				email: foundUser.email,
				accessToken: accessToken,
			});
		} else {
			res.sendStatus(401);
		}
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Internal server error' });
	}
};
