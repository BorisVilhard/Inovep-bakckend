// backend/utils/email.js

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

export const sendResetCodeEmail = async (toEmail, resetCode) => {
	const transporter = nodemailer.createTransport({
		service: 'Gmail',
		auth: {
			user: 'borisvilhard.7@gmail.com',
			pass: 'sukq zntg utbs kzsd',
		},
	});

	const mailOptions = {
		from: 'borisvilhard.7@gmail.com',
		to: toEmail,
		subject: 'Your Password Reset Code',
		text: `Your password reset code is: ${resetCode}. It is valid for 10 minutes.`,
	};

	await transporter.sendMail(mailOptions);
};
