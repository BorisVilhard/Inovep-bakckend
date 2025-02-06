/**
 * Merges new dashboardData into existing dashboardData.
 * @param {Array} existingData - Existing dashboardData.
 * @param {Array} newData - New dashboardData to merge.
 * @returns {Array} - Merged dashboardData.
 */
export const mergeDashboardData = (existingData, newData) => {
	const mergedData = [...existingData];

	newData.forEach((newCategory) => {
		const existingCategory = mergedData.find(
			(cat) => cat.categoryName === newCategory.categoryName
		);

		if (existingCategory) {
			// Merge mainData
			newCategory.mainData.forEach((newChart) => {
				const existingChart = existingCategory.mainData.find(
					(chart) => chart.id === newChart.id
				);

				if (existingChart) {
					const newValue = newChart.data[0]?.value;
					if (typeof newValue === 'string') {
						// Replace existing data with new data
						existingChart.data = newChart.data;
					} else if (newChart.isChartTypeChanged) {
						// Replace existing data and update chartType
						existingChart.data = newChart.data;
						existingChart.chartType = newChart.chartType;
						existingChart.isChartTypeChanged = true;
					} else {
						// Merge data arrays
						existingChart.data = [...existingChart.data, ...newChart.data];
					}
				} else {
					existingCategory.mainData.push(newChart);
				}
			});

			// Merge combinedData
			if (newCategory.combinedData && newCategory.combinedData.length > 0) {
				newCategory.combinedData.forEach((newCombinedChart) => {
					const existingCombinedChart = existingCategory.combinedData.find(
						(chart) => chart.id === newCombinedChart.id
					);

					if (existingCombinedChart) {
						// Update if necessary
						existingCombinedChart.chartType = newCombinedChart.chartType;
						existingCombinedChart.chartIds = newCombinedChart.chartIds;
						existingCombinedChart.data = newCombinedChart.data;
					} else {
						existingCategory.combinedData.push(newCombinedChart);
					}
				});
			}

			// Merge summaryData
			if (newCategory.summaryData && newCategory.summaryData.length > 0) {
				existingCategory.summaryData = [
					...existingCategory.summaryData,
					...newCategory.summaryData,
				];
			}
		} else {
			// Add new category
			mergedData.push(newCategory);
		}
	});

	return mergedData;
};
