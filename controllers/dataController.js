// controllers/dataController.js

import Dashboard from '../model/Data.js';
import mongoose from 'mongoose';

// Verify User Ownership Middleware
export const verifyUserOwnership = (req, res, next) => {
	const userIdFromToken = req.user.id;
	const userIdFromParams = req.params.id;

	console.log('User ID from Token:', userIdFromToken);
	console.log('User ID from Params:', userIdFromParams);

	if (userIdFromToken !== userIdFromParams) {
		console.log('User ID mismatch');
		return res.status(403).json({ message: 'Access denied' });
	}
	next();
};

// Get all dashboards for a user
export const getAllDashboards = async (req, res) => {
	const userId = req.params.id;
	try {
		const dashboards = await Dashboard.find({ userId });
		if (!dashboards || dashboards.length === 0) {
			return res.status(204).json({ message: 'No dashboards found' });
		}
		res.json(dashboards);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Get a specific dashboard for a user
export const getDashboardById = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	try {
		// Validate dashboardId
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboard ID' });
		}
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}
		res.json(dashboard);
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Create a new dashboard for a user
export const createDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardData, DashboardId } = req.body;

	if (!dashboardData || DashboardId === undefined) {
		return res
			.status(400)
			.json({ message: 'dashboardData and DashboardId are required' });
	}

	try {
		// Check for unique DashboardId
		const existingDashboard = await Dashboard.findOne({ DashboardId });
		if (existingDashboard) {
			return res.status(400).json({ message: 'DashboardId must be unique' });
		}

		const newDashboard = new Dashboard({
			DashboardId,
			dashboardData,
			userId,
		});

		await newDashboard.save();
		res.status(201).json({
			message: 'Dashboard created successfully',
			dashboard: newDashboard,
		});
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Update an existing dashboard for a user
export const updateDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;
	const { dashboardData } = req.body;

	if (!dashboardData) {
		return res.status(400).json({ message: 'dashboardData is required' });
	}

	try {
		if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
			return res.status(400).json({ message: 'Invalid dashboard ID' });
		}
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Update the dashboardData
		dashboard.dashboardData = dashboardData;

		await dashboard.save();
		res.json({ message: 'Dashboard updated successfully', dashboard });
	} catch (error) {
		res.status(500).json({ message: 'Server error', error });
	}
};

// Delete a dashboard for a user
export const deleteDashboard = async (req, res) => {
	const userId = req.params.id;
	const { dashboardId } = req.params;

	console.log('Deleting dashboard:', dashboardId, 'for user:', userId);

	// Validate dashboardId
	if (!mongoose.Types.ObjectId.isValid(dashboardId)) {
		return res.status(400).json({ message: 'Invalid dashboard ID' });
	}

	try {
		const dashboard = await Dashboard.findOne({ _id: dashboardId, userId });
		if (!dashboard) {
			return res
				.status(404)
				.json({ message: `Dashboard ID ${dashboardId} not found` });
		}

		// Use deleteOne()
		await dashboard.deleteOne();
		res.json({ message: 'Dashboard deleted successfully' });
	} catch (error) {
		console.error('Error deleting dashboard:', error);
		res.status(500).json({ message: 'Server error', error });
	}
};
