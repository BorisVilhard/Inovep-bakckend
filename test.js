import { mergeDashboardData } from './utils/dashboardUtils.js';

const existingData = [
	{
		categoryName: 'Sales',
		mainData: [
			{
				id: 'chart1',
				chartType: 'Bar',
				data: [
					{
						title: 'Q1',
						value: 5000,
						date: '2023-01-01',
						fileName: 'sales.csv',
					},
					{
						title: 'Q2',
						value: 7000,
						date: '2023-04-01',
						fileName: 'sales.csv',
					},
				],
				isChartTypeChanged: false,
				fileName: 'sales.csv',
			},
		],
		combinedData: [
			{
				id: 'combinedChart1',
				chartType: 'Line',
				chartIds: ['chart1'],
				data: [
					{
						title: 'Q1',
						value: 5000,
						date: '2023-01-01',
						fileName: 'sales.csv',
					},
					{
						title: 'Q2',
						value: 7000,
						date: '2023-04-01',
						fileName: 'sales.csv',
					},
				],
			},
		],
		summaryData: [
			{
				title: 'Total Sales',
				value: 12000,
				date: '2023-06-01',
				fileName: 'sales.csv',
			},
		],
	},
];

const newData = [
	{
		categoryName: 'Sales',
		mainData: [
			{
				id: 'chart1',
				chartType: 'Bar',
				data: [
					{
						title: 'Q3',
						value: 8000,
						date: '2023-07-01',
						fileName: 'sales_updated.csv',
					},
				],
				isChartTypeChanged: false,
				fileName: 'sales_updated.csv',
			},
			{
				id: 'chart2',
				chartType: 'Line',
				data: [
					{
						title: 'Q1',
						value: 6000,
						date: '2023-01-01',
						fileName: 'sales_updated.csv',
					},
				],
				isChartTypeChanged: false,
				fileName: 'sales_updated.csv',
			},
		],
		combinedData: [
			{
				id: 'combinedChart1',
				chartType: 'Line',
				chartIds: ['chart1', 'chart2'],
				data: [
					{
						title: 'Q1',
						value: 6000,
						date: '2023-01-01',
						fileName: 'sales_updated.csv',
					},
				],
			},
		],
		summaryData: [
			{
				title: 'Total Sales',
				value: 20000,
				date: '2023-09-01',
				fileName: 'sales_updated.csv',
			},
		],
	},
	{
		categoryName: 'Marketing',
		mainData: [
			{
				id: 'chart3',
				chartType: 'Pie',
				data: [
					{
						title: 'Campaign A',
						value: 3000,
						date: '2023-06-01',
						fileName: 'marketing.csv',
					},
				],
				isChartTypeChanged: false,
				fileName: 'marketing.csv',
			},
		],
		combinedData: [],
		summaryData: [
			{
				title: 'Total Spend',
				value: 5000,
				date: '2023-06-01',
				fileName: 'marketing.csv',
			},
		],
	},
];

const mergedData = mergeDashboardData(existingData, newData);
console.log(JSON.stringify(mergedData, null, 2));
