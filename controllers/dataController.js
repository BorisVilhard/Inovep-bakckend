// controllers/dataController.js

import Data from '../model/Data.js';

export const getAllData = async (req, res) => {
	try {
		const data = await Data.find();
		if (!data.length) return res.status(204).json({ message: 'No data found' });
		res.json(data);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

export const getData = async (req, res) => {
	const { id } = req.params;
	if (!id) return res.status(400).json({ message: 'Data ID required' });

	try {
		const data = await Data.findById(id);
		if (!data)
			return res.status(404).json({ message: `Data ID ${id} not found` });
		res.json(data);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Create new data
export const createData = async (req, res) => {
	const { DashboardId, dashboardData } = req.body;
	if (!DashboardId || !dashboardData) {
		return res
			.status(400)
			.json({ message: 'DashboardId and dashboardData are required' });
	}

	try {
		const newData = new Data({ DashboardId, dashboardData });
		await newData.save();
		res
			.status(201)
			.json({ message: 'Data created successfully', data: newData });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

export const updateData = async (req, res) => {
	const { id } = req.params;
	const { DashboardId, dashboardData } = req.body;

	if (!id) return res.status(400).json({ message: 'Data ID required' });

	try {
		const data = await Data.findById(id);
		if (!data)
			return res.status(404).json({ message: `Data ID ${id} not found` });

		// Update fields if they are provided
		if (DashboardId !== undefined) data.DashboardId = DashboardId;
		if (dashboardData !== undefined) data.dashboardData = dashboardData;

		await data.save();
		res.json({ message: 'Data updated successfully!', data });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete data (Dashboard)
export const deleteDashboard = async (req, res) => {
	const { id } = req.params; // Dashboard ID
	if (!id) return res.status(400).json({ message: 'Dashboard ID required' });

	try {
		const dashboard = await Data.findById(id);
		if (!dashboard)
			return res.status(404).json({ message: `Dashboard ID ${id} not found` });

		await dashboard.remove();
		res.json({ message: 'Dashboard deleted successfully' });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete Category within a Dashboard
export const deleteCategory = async (req, res) => {
	const { id, categoryName } = req.params;

	if (!id || !categoryName) {
		return res
			.status(400)
			.json({ message: 'Dashboard ID and category name required' });
	}

	try {
		const dashboard = await Data.findById(id);
		if (!dashboard)
			return res.status(404).json({ message: `Dashboard ID ${id} not found` });

		const updatedDashboardData = dashboard.dashboardData.filter(
			(category) => category.categoryName !== categoryName
		);

		if (updatedDashboardData.length === dashboard.dashboardData.length) {
			return res
				.status(404)
				.json({ message: `Category ${categoryName} not found` });
		}

		dashboard.dashboardData = updatedDashboardData;
		await dashboard.save();

		res.json({
			message: `Category ${categoryName} deleted successfully`,
			dashboard,
		});
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete Chart within a Category
export const deleteChart = async (req, res) => {
	const { id, categoryName, chartId } = req.params;

	if (!id || !categoryName || chartId === undefined) {
		return res.status(400).json({
			message: 'Dashboard ID, category name, and chart ID required',
		});
	}

	try {
		const dashboard = await Data.findById(id);
		if (!dashboard)
			return res.status(404).json({ message: `Dashboard ID ${id} not found` });

		const category = dashboard.dashboardData.find(
			(cat) => cat.categoryName === categoryName
		);

		if (!category) {
			return res
				.status(404)
				.json({ message: `Category ${categoryName} not found` });
		}

		const updatedMainData = category.mainData.filter(
			(chart) => chart.id !== Number(chartId)
		);

		if (updatedMainData.length === category.mainData.length) {
			return res.status(404).json({ message: `Chart ID ${chartId} not found` });
		}

		category.mainData = updatedMainData;

		await dashboard.save();

		res.json({
			message: `Chart ID ${chartId} deleted successfully`,
			dashboard,
		});
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};
