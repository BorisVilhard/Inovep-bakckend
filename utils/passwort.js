// config/passport.js
import passport from 'passport';
import GoogleStrategy from 'passport-google-oauth20';
import User from '../model/User.js';

passport.use(
	new GoogleStrategy(
		{
			clientID: process.env.GOOGLE_CLIENT_ID,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET,
			callbackURL: '/auth/google/callback',
		},
		async (accessToken, refreshToken, profile, done) => {
			try {
				const existingUser = await User.findOne({ googleId: profile.id });

				if (existingUser) {
					// User exists, proceed to login
					return done(null, existingUser);
				}

				// Check if a user with the same email exists
				const emailUser = await User.findOne({
					email: profile.emails[0].value,
				});
				if (emailUser) {
					// Link Google account to existing user
					emailUser.googleId = profile.id;
					await emailUser.save();
					return done(null, emailUser);
				}

				// Create a new user
				const newUser = await User.create({
					username: profile.displayName,
					email: profile.emails[0].value,
					googleId: profile.id,
					// No password since it's a Google account
				});

				return done(null, newUser);
			} catch (error) {
				console.error('Error in Google Strategy:', error);
				return done(error, null);
			}
		}
	)
);

// Serialize and Deserialize User (optional based on session usage)
passport.serializeUser((user, done) => {
	done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
	try {
		const user = await User.findById(id);
		done(null, user);
	} catch (err) {
		done(err, null);
	}
});
