import { parse } from 'csv-parse';
import xlsx from 'xlsx';
import { CustomError } from './CustomError.js';

export async function parseFile(buffer, fileType) {
	try {
		if (fileType === 'text/csv') {
			const parser = parse({ columns: true });
			const data = await new Promise((resolve, reject) => {
				parser.on('readable', () => {
					let record;
					const records = [];
					while ((record = parser.read())) {
						records.push(record);
					}
					resolve(records);
				});
				parser.on('error', reject);
				parser.write(buffer);
				parser.end();
			});
			return data;
		} else if (
			fileType ===
				'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			fileType === 'application/vnd.ms-excel'
		) {
			const workbook = xlsx.read(buffer, { type: 'buffer' });
			const sheetName = workbook.SheetNames[0];
			const sheet = workbook.Sheets[sheetName];
			const data = xlsx.utils.sheet_to_json(sheet);
			return data;
		} else {
			throw new CustomError(400, `Unsupported file type: ${fileType}`);
		}
	} catch (error) {
		throw new CustomError(400, `Failed to parse file: ${error.message}`);
	}
}
