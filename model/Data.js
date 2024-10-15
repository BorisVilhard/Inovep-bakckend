import mongoose from 'mongoose';

const dashboardSchema = new mongoose.Schema({
	dashboardName: {
		type: String,
		required: true,
	},
	dashboardData: {
		type: Array,
		default: [],
	},
	files: {
		type: Array,
		default: [],
	},
	userId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},
});

const Dashboard = mongoose.model('Dashboard', dashboardSchema);

export default Dashboard;
