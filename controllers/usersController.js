const User = require('../model/User');
const bcrypt = require('bcrypt');

const getAllUsers = async (req, res) => {
	const users = await User.find();
	if (!users) return res.status(204).json({ message: 'No users found' });
	res.json(users);
};

const deleteUser = async (req, res) => {
	const { id } = req.params; // Make sure you're pulling from params
	if (!id) {
		return res.status(400).json({ message: 'User ID required' });
	}
	const user = await User.findById(id); // Use findById for simplicity
	if (!user) {
		return res.status(404).json({ message: `User ID ${id} not found` });
	}
	await user.remove(); // Using remove to delete the user
	res.json({ message: 'User deleted successfully' });
};

const updateUser = async (req, res) => {
	const { id } = req.params;
	const { username, email, password } = req.body;

	if (!id) return res.status(400).json({ message: 'User ID required' });

	try {
		const user = await User.findById(id);
		if (!user)
			return res.status(404).json({ message: `User ID ${id} not found` });

		if (password) {
			const salt = await bcrypt.genSalt(10);
			user.password = await bcrypt.hash(password, salt);
		}

		user.username = username || user.username;
		user.email = email || user.email;

		await user.save();
		res.json({ message: 'User updated successfully!', user });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

const getUser = async (req, res) => {
	if (!req?.params?.id)
		return res.status(400).json({ message: 'User ID required' });
	const user = await User.findOne({ _id: req.params.id }).exec();
	if (!user) {
		return res
			.status(204)
			.json({ message: `User ID ${req.params.id} not found` });
	}
	res.json(user);
};

module.exports = {
	getAllUsers,
	deleteUser,
	updateUser,
	getUser,
};
