import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const Schema = mongoose.Schema;

const userSchema = new Schema(
	{
		username: { type: String, required: true },
		email: { type: String, required: true, unique: true },
		password: { type: String },
		googleId: { type: String },
		refreshToken: { type: String },
		resetCode: { type: String },
		resetCodeExpiration: { type: Date },
		// NEW: tokens for offline access to Drive, Docs, Sheets, etc.
		googleDriveTokens: {
			access_token: { type: String },
			refresh_token: { type: String },
			scope: { type: String },
			token_type: { type: String },
			expiry_date: { type: Number },
		},
	},
	{ timestamps: true }
);

// Hash the password if modified
userSchema.pre('save', async function (next) {
	if (this.password && this.isModified('password')) {
		const salt = await bcrypt.genSalt(10);
		this.password = await bcrypt.hash(this.password, salt);
	}
	next();
});

export default mongoose.model('User', userSchema);
