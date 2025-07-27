// router.js
import express from 'express';
import {
	quickbooksConnect,
	quickbooksCallback,
	quickbooksAllData,
	getPohodaToken,
	getPohodaReceivedInvoices,
	getPohodaReceivedOrders,
	getPohodaIssuedInvoices,
	getPohodaStockItems,
	getPohodaBills,
	getPohodaProfitLossReport,
} from '../controllers/thirdPartyUploadController.js';

const router = express.Router();

// QuickBooks routes
router.get('/quickbooks/connect', quickbooksConnect);
router.get('/quickbooks/callback', quickbooksCallback);
router.get('/quickbooks/all-data', quickbooksAllData); // Applied auth middleware

// Pohoda routes
router.post('/pohoda/token', getPohodaToken); // No auth middleware
router.get('/pohoda/received-invoices', getPohodaReceivedInvoices); // Optional: Apply if needed
router.get('/pohoda/received-orders', getPohodaReceivedOrders); // Optional: Apply if needed
router.get('/pohoda/issued-invoices', getPohodaIssuedInvoices); // Optional: Apply if needed
router.get('/pohoda/stock-items', getPohodaStockItems); // Optional: Apply if needed
router.get('/pohoda/bills', getPohodaBills); // Optional: Apply if needed
router.get('/pohoda/profit-loss-report', getPohodaProfitLossReport); // Optional: Apply if needed

export default router;
