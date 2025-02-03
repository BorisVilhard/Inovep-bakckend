import User from './model/User.js';

/**
 * Save the tokens for a given userId.
 *
 * @param {String} userId - The ID of the user.
 * @param {Object} tokens - The token object, for example:
 *   {
 *     access_token: '...',
 *     refresh_token: '...',
 *     scope: '...',
 *     token_type: 'Bearer',
 *     expiry_date: 1234567890,
 *   }
 * @returns {Promise<Object>} - The updated user document.
 */
export async function saveTokens(userId, tokens) {
	try {
		// Update the user's googleDriveTokens field with the new tokens
		const updatedUser = await User.findByIdAndUpdate(
			userId,
			{
				googleDriveTokens: {
					access_token: tokens.access_token || null,
					refresh_token: tokens.refresh_token || null,
					scope: tokens.scope || null,
					token_type: tokens.token_type || null,
					expiry_date: tokens.expiry_date || null,
				},
			},
			{ new: true } // returns the updated document
		);
		return updatedUser;
	} catch (error) {
		console.error('Error saving tokens to MongoDB:', error);
		throw error;
	}
}

/**
 * Retrieve tokens for a given userId.
 *
 * @param {String} userId - The ID of the user.
 * @returns {Promise<Object|null>} - The googleDriveTokens object or null if not found.
 */
export async function getTokens(userId) {
	try {
		const user = await User.findById(userId).select('googleDriveTokens');
		if (!user || !user.googleDriveTokens) {
			return null;
		}
		return user.googleDriveTokens;
	} catch (error) {
		console.error('Error retrieving tokens from MongoDB:', error);
		throw error;
	}
}
