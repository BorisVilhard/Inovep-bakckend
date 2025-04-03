/**
 *
 *
 * @param {string} documentText - The JSON string representing an array of objects.
 * @returns {string} - A string of valid JavaScript code defining the 'data' array.
 * @throws {Error} - Throws an error if the input text is not valid JSON or is not an array.
 */
export const transformExcelDataToJSCode = (documentText) => {
	try {
		// Parse the input text as JSON
		const data = JSON.parse(documentText);

		// Check that the parsed data is an array
		if (!Array.isArray(data)) {
			throw new Error('Parsed data is not an array of objects.');
		}

		// Convert the array back into a nicely formatted JSON string
		const code = `const data = ${JSON.stringify(data, null, 4)};`;
		return code;
	} catch (error) {
		console.error('Error transforming Excel data to JavaScript code:', error);
		throw error;
	}
};
