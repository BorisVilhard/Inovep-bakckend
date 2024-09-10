const User = require('../model/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const handleNewUser = async (req, res) => {
	try {
		const { username, email, password } = req.body;
		if (!username || !email || !password) {
			return res.status(400).json({ message: 'All fields are required' });
		}

		const duplicate = await User.findOne({ email: email }).exec();
		if (duplicate) {
			return res.status(409).json({ message: 'Email is already in use' });
		}

		const hashedPwd = await bcrypt.hash(password, 10);
		const newUser = await User.create({
			username,
			email,
			password: hashedPwd,
		});

		const accessToken = jwt.sign(
			{ username: newUser.username, email: newUser.email },
			process.env.ACCESS_TOKEN_SECRET,
			{ expiresIn: '10m' }
		);

		const refreshToken = jwt.sign(
			{ username: newUser.username },
			process.env.REFRESH_TOKEN_SECRET,
			{ expiresIn: '1d' }
		);

		newUser.refreshToken = refreshToken;
		await newUser.save();

		res.status(201).json({
			id: newUser._id,
			username: newUser.username,
			email: newUser.email,
			accessToken: accessToken,
		});
	} catch (err) {
		console.error('Registration error:', err.message);
		res
			.status(500)
			.json({ message: 'Internal Server Error', error: err.message });
	}
};

module.exports = { handleNewUser };
