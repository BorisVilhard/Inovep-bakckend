import User from '../model/User.js';
import { sendResetCodeEmail } from '../utils/email.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

export const forgotPassword = async (req, res) => {
	const { email } = req.body;

	if (!email) {
		return res.status(400).json({ message: 'Email is required.' });
	}

	try {
		const user = await User.findOne({ email }).exec();

		if (!user) {
			return res
				.status(404)
				.json({ message: 'No user found with that email address.' });
		}

		// Generate a 6-digit reset code
		const resetCode = crypto.randomInt(100000, 999999).toString();

		// Set expiration time (10 minutes from now)
		const resetCodeExpiration = Date.now() + 10 * 60 * 1000; // 10 minutes

		// Save the reset code and expiration in the user document
		user.resetCode = resetCode;
		user.resetCodeExpiration = resetCodeExpiration;
		await user.save();

		// Send the reset code via email
		await sendResetCodeEmail(user.email, resetCode);

		res.json({ message: 'Verification code sent to your email.' });
	} catch (error) {
		console.error('Error in forgotPassword:', error);
		res.status(500).json({ message: 'Server error.', error: error.message });
	}
};

// Handle Verify Reset Code
export const verifyResetCode = async (req, res) => {
	const { email, code } = req.body;

	if (!email || !code) {
		return res.status(400).json({ message: 'Email and code are required.' });
	}

	try {
		const user = await User.findOne({ email }).exec();

		if (!user) {
			return res
				.status(404)
				.json({ message: 'No user found with that email address.' });
		}

		// Check if reset code exists and matches
		if (!user.resetCode || user.resetCode !== code) {
			return res.status(400).json({ message: 'Invalid verification code.' });
		}

		// Check if the reset code has expired
		if (Date.now() > user.resetCodeExpiration) {
			return res
				.status(400)
				.json({ message: 'Verification code has expired.' });
		}

		// If all checks pass
		res.json({ message: 'Verification successful.' });
	} catch (error) {
		console.error('Error in verifyResetCode:', error);
		res.status(500).json({ message: 'Server error.', error: error.message });
	}
};

// Handle Reset Password
export const resetPassword = async (req, res) => {
	const { email, code, newPassword } = req.body;

	if (!email || !code || !newPassword) {
		return res
			.status(400)
			.json({ message: 'Email, code, and new password are required.' });
	}

	try {
		const user = await User.findOne({ email }).exec();

		if (!user) {
			return res
				.status(404)
				.json({ message: 'No user found with that email address.' });
		}

		// Check if reset code exists and matches
		if (!user.resetCode || user.resetCode !== code) {
			return res.status(400).json({ message: 'Invalid verification code.' });
		}

		// Check if the reset code has expired
		if (Date.now() > user.resetCodeExpiration) {
			return res
				.status(400)
				.json({ message: 'Verification code has expired.' });
		}

		// Hash the new password
		const salt = await bcrypt.genSalt(10);
		const hashedPassword = await bcrypt.hash(newPassword, salt);

		// Update the user's password and remove reset code fields
		user.password = hashedPassword;
		user.resetCode = undefined;
		user.resetCodeExpiration = undefined;
		await user.save();

		res.json({ message: 'Password has been reset successfully.' });
	} catch (error) {
		console.error('Error in resetPassword:', error);
		res.status(500).json({ message: 'Server error.', error: error.message });
	}
};
