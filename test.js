import { format } from 'date-fns';

// Function to extract JavaScript code containing array declarations from the response string
function extractJavascriptCode(response) {
	try {
		// Regex pattern to match JavaScript array declarations
		const jsCodePattern = /const\s+\w+\s*=\s*\[.*?\];/s;
		const match = response.match(jsCodePattern);

		if (match) {
			let jsArrayString = match[0];
			// Remove any comments from the JavaScript code
			jsArrayString = jsArrayString.replace(/\/\/.*/g, '');
			// Extract the array portion from the JavaScript declaration
			let jsonLikeString = jsArrayString.substring(
				jsArrayString.indexOf('['),
				jsArrayString.lastIndexOf(']') + 1
			);
			// Convert JavaScript object notation to JSON format
			jsonLikeString = jsonLikeString.replace(/(\w+):/g, '"$1":');
			jsonLikeString = jsonLikeString.replace(/'/g, '"');
			// Handle JavaScript null and undefined values
			jsonLikeString = jsonLikeString.replace(/\b(null|undefined)\b/g, 'null');
			// Remove trailing commas before array closures
			jsonLikeString = jsonLikeString.replace(/,\s*\]/g, ']');
			// Parse the cleaned string into JSON
			return JSON.parse(jsonLikeString);
		} else {
			return [];
		}
	} catch (error) {
		console.error('Error decoding JSON:', error);
		return [];
	}
}

// Function to clean numeric values in strings and convert to appropriate data type
function cleanNumeric(value) {
	if (typeof value === 'string') {
		// Search for numeric patterns including optional negative signs and decimals
		const numMatch = value.match(/-?\d+(\.\d+)?/);
		if (numMatch) {
			const numStr = numMatch[0];
			// Convert to float if it contains a decimal point, otherwise to int
			return numStr.includes('.') ? parseFloat(numStr) : parseInt(numStr, 10);
		}
	}
	return value;
}

// Function to transform data structure
function transformDataStructure(data) {
	const result = [];
	const today = format(new Date(), 'yyyy-MM-dd');
	let idCounter = 1; // Initialize ID counter

	data.forEach((item) => {
		// Dynamically identify the group name key, assuming it is the first key in the item.
		const groupNameKey = Object.keys(item)[0];
		const name = item[groupNameKey];
		delete item[groupNameKey];

		if (name) {
			const pokemonData = [];
			for (const [key, value] of Object.entries(item)) {
				const cleanedValue = cleanNumeric(value);
				pokemonData.push({
					chartType: 'Area',
					id: idCounter, // Assign ID
					data: [
						{
							title: key,
							value: cleanedValue,
							date: today,
						},
					],
				});
				idCounter += 1; // Increment ID counter
			}
			result.push({ [name]: pokemonData });
		}
	});

	// Wrapping the result in the desired format
	const finalOutput = { DashboardId: 1, dashboardData: result };

	return finalOutput; // Return the final output in the desired format
}

// Example response text containing JavaScript data
const responseText = `
const data = [
    {"Month": "January", "Profit ($)": 8994},
    {"Month": "February", "Profit ($)": 4688},
    {"Month": "March", "Profit ($)": 14513},
    {"Month": "April", "Profit ($)": 18288},
    {"Month": "May", "Profit ($)": 9400},
    {"Month": "June", "Profit ($)": 14261},
    {"Month": "July", "Profit ($)": 14115},
    {"Month": "August", "Profit ($)": 10061},
    {"Month": "September", "Profit ($)": 4447},
    {"Month": "October", "Profit ($)": 9542},
    {"Month": "November", "Profit ($)": 6610},
    {"Month": "December", "Profit ($)": 4498}
];
`;

// Extract and transform the data
const extractedData = extractJavascriptCode(responseText);
const formedData = transformDataStructure(extractedData);

// Print the transformed data
console.log('data=', JSON.stringify(formedData, null, 4));
