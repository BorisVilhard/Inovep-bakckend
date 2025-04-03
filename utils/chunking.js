/**
 * Conditionally chunks an array into subarrays of a given size.
 * If the array's length is less than or equal to the specified chunk size,
 * the original array is returned.
 *
 * @param {Array} array - The array to be conditionally chunked.
 * @param {number} chunkSize - The maximum size of each chunk.
 * @returns {Array|Array[]} - Returns the original array if its length is less than or equal to chunkSize,
 *                            otherwise returns an array of chunks.
 */
export function conditionalChunkArray(array, chunkSize) {
	if (!Array.isArray(array)) {
		throw new Error('Input must be an array.');
	}
	if (array.length <= chunkSize) {
		return array;
	}

	const chunks = [];
	for (let i = 0; i < array.length; i += chunkSize) {
		chunks.push(array.slice(i, i + chunkSize));
	}
	return chunks;
}
