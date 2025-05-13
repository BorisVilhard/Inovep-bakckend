/**
 * Merges new dashboardData into existing dashboardData efficiently.
 * @param {Array} existingData - Existing dashboardData.
 * @param {Array} newData - New dashboardData to merge.
 * @returns {Array} - Merged dashboardData.
 */
export const mergeDashboardData = (existingData, newData) => {
	// Create a map for existing categories using categoryName as the key
	const categoryMap = new Map(
		existingData.map((cat) => [cat.categoryName, { ...cat }])
	);

	newData.forEach((newCategory) => {
		const categoryName = newCategory.categoryName;

		// Check if the category already exists in the map
		if (categoryMap.has(categoryName)) {
			const existingCategory = categoryMap.get(categoryName);

			// Create a map for existing charts in the category using chart id as the key
			const chartMap = new Map(
				existingCategory.mainData.map((chart) => [chart.id, chart])
			);

			// Merge mainData
			newCategory.mainData.forEach((newChart) => {
				if (chartMap.has(newChart.id)) {
					const existingChart = chartMap.get(newChart.id);
					const newValue = newChart.data[0]?.value;

					if (typeof newValue === 'string') {
						existingChart.data = newChart.data;
					} else if (newChart.isChartTypeChanged) {
						existingChart.data = newChart.data;
						existingChart.chartType = newChart.chartType;
						existingChart.isChartTypeChanged = true;
					} else {
						existingChart.data = [...existingChart.data, ...newChart.data];
					}
				} else {
					// If the chart doesn't exist, add it to the category's mainData
					existingCategory.mainData.push(newChart);
					chartMap.set(newChart.id, newChart); // Update the map for future lookups
				}
			});

			// Merge combinedData if it exists
			if (newCategory.combinedData && newCategory.combinedData.length > 0) {
				const combinedChartMap = new Map(
					existingCategory.combinedData?.map((chart) => [chart.id, chart]) || []
				);

				newCategory.combinedData.forEach((newCombinedChart) => {
					if (combinedChartMap.has(newCombinedChart.id)) {
						const existingCombinedChart = combinedChartMap.get(
							newCombinedChart.id
						);
						existingCombinedChart.chartType = newCombinedChart.chartType;
						existingCombinedChart.chartIds = newCombinedChart.chartIds;
						existingCombinedChart.data = newCombinedChart.data;
					} else {
						// If the combined chart doesn't exist, add it
						if (!existingCategory.combinedData) {
							existingCategory.combinedData = [];
						}
						existingCategory.combinedData.push(newCombinedChart);
						combinedChartMap.set(newCombinedChart.id, newCombinedChart);
					}
				});
			}

			// Merge summaryData if it exists
			if (newCategory.summaryData && newCategory.summaryData.length > 0) {
				if (!existingCategory.summaryData) {
					existingCategory.summaryData = [];
				}
				existingCategory.summaryData = [
					...existingCategory.summaryData,
					...newCategory.summaryData,
				];
			}
		} else {
			// If the category doesn't exist, add the entire new category
			categoryMap.set(categoryName, newCategory);
		}
	});

	// Convert the map back to an array and return
	return Array.from(categoryMap.values());
};
