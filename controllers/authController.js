const User = require('../model/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

exports.handleLogin = async (req, res) => {
	const { user, pwd } = req.body;

	if (!user || !pwd)
		return res
			.status(400)
			.json({ message: 'Username and password are required.' });

	const foundUser = await User.findOne({ username: user }).exec();
	if (!foundUser) return res.sendStatus(401);

	const match = await bcrypt.compare(pwd, foundUser.password);
	if (match) {
		const accessToken = jwt.sign(
			{ username: foundUser.username, email: foundUser.email },
			process.env.ACCESS_TOKEN_SECRET,
			{ expiresIn: '10m' }
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
};
