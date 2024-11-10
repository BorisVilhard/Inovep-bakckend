import User from '../model/User.js';
import bcrypt from 'bcrypt';

export const getAllUsers = async (req, res) => {
	try {
		const users = await User.find().select('-password');
		if (!users) return res.status(204).json({ message: 'No users found' });
		res.json(users);
	} catch (error) {
		console.error('Error fetching users:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

export const getUser = async (req, res) => {
	const { id } = req.params;
	if (!id) return res.status(400).json({ message: 'User ID required' });
	try {
		const user = await User.findOne({ _id: id }).select('-password').exec();
		if (!user) {
			return res.status(404).json({ message: `User ID ${id} not found` });
		}
		res.json(user);
	} catch (error) {
		console.error('Error fetching user:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

// Update User
export const updateUser = async (req, res) => {
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
		res.json({
			message: 'User updated successfully!',
			user: { username: user.username, email: user.email },
		});
	} catch (error) {
		console.error('Error updating user:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete User
export const deleteUser = async (req, res) => {
	const { id } = req.params;
	if (!id) {
		return res.status(400).json({ message: 'User ID required' });
	}
	try {
		const user = await User.findById(id);
		if (!user) {
			return res.status(404).json({ message: `User ID ${id} not found` });
		}
		await user.remove();
		res.json({ message: 'User deleted successfully' });
	} catch (error) {
		console.error('Error deleting user:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};
