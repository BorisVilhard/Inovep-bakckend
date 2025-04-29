import express from 'express';
import {
	stripePaymentWebhook,
	createSubscriptionIntent,
	cancelSubscription,
	terminatePendingSubscription,
	clearPendingSubscription,
	topJob,
} from '../controllers/paymentController.js';
import verifyJWT from '../middleware/verifyJWT.js';

const router = express.Router();

/**
 * POST /payment/subscription/create-subscription-intent
 * Create a Stripe checkout session for a subscription.
 * Requires authentication via JWT.
 */
router.post(
	'/subscription/create-subscription-intent',
	verifyJWT,
	createSubscriptionIntent
);

/**
 * POST /payment/subscription/cancel
 * Cancel an active subscription and downgrade to Free plan.
 * Requires authentication via JWT.
 */
router.post('/subscription/cancel', verifyJWT, cancelSubscription);

/**
 * POST /payment/subscription/terminate-pending
 * Terminate a pending subscription and issue a refund if applicable.
 * Requires authentication via JWT.
 */
router.post(
	'/subscription/terminate-pending',
	verifyJWT,
	terminatePendingSubscription
);

/**
 * POST /payment/subscription/clear-pending
 * Clear a pending subscription when checkout is canceled.
 * Requires authentication via JWT.
 */
router.post('/subscription/clear-pending', verifyJWT, clearPendingSubscription);

router.post('/subscription/topJob', verifyJWT, topJob);

/**
 * POST /payment/webhook
 * Handle Stripe webhook events (e.g., checkout.session.completed, invoice.payment_succeeded).
 * Public endpoint (no JWT required) for Stripe to send events.
 */
router.post('/webhook', stripePaymentWebhook);

export default router;
