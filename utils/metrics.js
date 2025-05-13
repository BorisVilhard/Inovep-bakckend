import { Gauge } from 'prom-client';

const metrics = {
	deletionDuration: new Gauge({
		name: 'dashboard_deletion_duration_seconds',
		help: 'Duration of dashboard deletion operations in seconds',
	}),
	gridFSDeletionErrors: new Gauge({
		name: 'gridfs_deletion_errors_total',
		help: 'Total number of GridFS deletion errors',
	}),
};

export default metrics;
