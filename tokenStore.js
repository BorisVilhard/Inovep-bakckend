// tokenStore.js
const tokenData = {
	// For demo, just store globally. For multiple users,
	// you'd store tokens by userId or email.
	access_token: null,
	refresh_token: null,
	expiry_date: null,
};
export function saveTokens(tokens) {
	tokenData.access_token = tokens.access_token || null;
	tokenData.refresh_token = tokens.refresh_token || null;
	tokenData.expiry_date = tokens.expiry_date || null;
}
export function getTokens() {
	return { ...tokenData };
}
