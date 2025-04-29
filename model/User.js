import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const Schema = mongoose.Schema;

// Subscription Schema
const subscriptionSchema = new Schema({
	planId: {
		type: String,
		enum: ['Monthly', 'Yearly'],
		default: 'Free',
	},
	role: {
		type: String,
		enum: ['regular', 'company'],
		default: 'regular',
	},
	tokensPerMonth: {
		type: Number,
		default: 1,
		min: [0, 'Tokens per month cannot be negative'],
	},
	subscriptionId: {
		type: String,
		default: null,
	},
	status: {
		type: String,
		enum: ['active', 'canceled', 'past_due', 'unpaid', 'trialing', null],
		default: 'active',
	},
	activeUntil: {
		type: Date,
		default: null,
	},
});

const pendingSubscriptionSchema = new Schema({
	planId: {
		type: String,
		enum: ['Monthly', 'Yearly'],
		default: null,
	},
	subscriptionId: {
		type: String,
		default: null,
	},
	scheduledActivation: {
		type: Date,
		default: null,
	},
});

const userSchema = new Schema(
	{
		username: {
			type: String,
			required: [true, 'Username is required'],
			trim: true,
		},
		email: {
			type: String,
			required: [true, 'Email is required'],
			unique: true,
			lowercase: true,
			trim: true,
			match: [/.+\@.+\..+/, 'Please enter a valid email address'],
		},
		password: {
			type: String,
			required: [true, 'Password is required'],
		},
		refreshToken: {
			type: String,
			default: null,
		},
		googleDriveTokens: {
			access_token: { type: String },
			refresh_token: { type: String },
			scope: { type: String },
			token_type: { type: String },
			expiry_date: { type: Number },
		},
		resetCode: {
			type: String,
			default: null,
		},
		resetCodeExpiration: {
			type: Number,
			default: null,
		},
		verificationCode: {
			type: String,
			default: null,
		},
		verificationCodeExpiration: {
			type: Number,
			default: null,
		},
		isVerified: {
			type: Boolean,
			default: false,
		},
		stripeCustomerId: {
			type: String,
			default: null,
		},
		tokens: {
			type: Number,
			default: 1,
			min: [0, 'Tokens cannot be negative'],
		},
		subscription: {
			type: subscriptionSchema,
			required: [true, 'Subscription is required'],
			default: () => ({
				planId: 'Monthly',
				tokensPerMonth: 1,
				status: 'active',
				activeUntil: null,
			}),
		},
		pendingSubscription: {
			type: pendingSubscriptionSchema,
			default: null,
		},
	},
	{
		timestamps: true,
	}
);

// Pre-save Hook
userSchema.pre('save', async function (next) {
	// Hash password if modified and not already hashed
	if (this.isModified('password') && !this.password.startsWith('$')) {
		const salt = await bcrypt.genSalt(10);
		this.password = await bcrypt.hash(this.password, salt);
	}

	// Set initial tokens for new users
	if (this.isNew) {
		this.tokens = this.subscription.tokensPerMonth || 1;
	}

	// Validate company details: regNumber and registeredAddress must both be provided or neither
	const regNumberProvided = !!this.regNumber && this.regNumber.trim() !== '';
	const registeredAddressProvided =
		!!this.registeredAddress && this.registeredAddress.trim() !== '';
	if (regNumberProvided !== registeredAddressProvided) {
		return next(
			new Error(
				'Both regNumber and registeredAddress must be provided together or neither'
			)
		);
	}

	next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
	return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.clearResetCode = function () {
	this.resetCode = null;
	this.resetCodeExpiration = null;
	return this.save();
};

userSchema.methods.clearVerificationCode = function () {
	this.verificationCode = null;
	this.verificationCodeExpiration = null;
	return this.save();
};

// Virtuals
userSchema.virtual('isCompany').get(function () {
	const hasCompanyRole =
		this.subscription && this.subscription.role === 'company';
	const hasCompanyDetails = !!(this.regNumber && this.registeredAddress);
	return hasCompanyRole || hasCompanyDetails;
});

// Schema Options
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

// Indexes
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ stripeCustomerId: 1 });

export default mongoose.model('User', userSchema);
