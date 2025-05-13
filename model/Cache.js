// model/Cache.js
const CacheSchema = new mongoose.Schema({
	key: { type: String, required: true, unique: true },
	value: { type: Object, required: true },
	expiresAt: {
		type: Date,
		expires: 3600,
		default: () => new Date(Date.now() + 3600 * 1000),
	},
});
export default mongoose.model('Cache', CacheSchema);
