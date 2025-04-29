import Stripe from 'stripe';
import { catchAsyncErrors } from '../utils/catch-async-error.js';
import { throwError } from '../utils/throw-error.js';
import User from '../model/User.js';
import { getPlanByName } from '../utils/plans.js';
import WebhookEvent from '../model/webhook.js';

// Initialize Stripe
if (!process.env.STRIPE_SECRET_KEY) {
	throw new Error('Missing Stripe secret key');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
	apiVersion: '2022-11-15',
});

function getStripePriceId(planName) {
	const priceIds = {
		Bronz: process.env.STRIPE_BRONZ_PRICE_ID,
		Silver: process.env.STRIPE_SILVER_PRICE_ID,
		Gold: process.env.STRIPE_GOLD_PRICE_ID,
		Standart: process.env.STRIPE_STANDART_PRICE_ID,
		Premium: process.env.STRIPE_PREMIUM_PRICE_ID,
	};
	const priceId = priceIds[planName];
	if (!priceId) {
		throwError(`Invalid or missing Stripe price ID for plan ${planName}`, 500);
	}
	return priceId;
}

export const createSubscriptionIntent = catchAsyncErrors(
	async (req, res, next) => {
		const { planName } = req.body;
		if (!planName) {
			console.error('Missing plan name in request');
			return next(throwError('Missing plan name', 400));
		}

		const plan = getPlanByName(planName);
		if (!plan) {
			console.error(`Invalid plan name: ${planName}`);
			return next(throwError(`Invalid plan: ${planName}`, 400));
		}
		if (plan.name === 'Free') {
			console.error('Attempt to subscribe to Free plan');
			return next(throwError('Cannot subscribe to Free plan', 400));
		}

		const user = await User.findById(req.user?.id);
		if (!user) {
			console.error(`User not found for id: ${req.user?.id}`);
			return next(throwError('User not found', 404));
		}

		// Require both regNumber and registeredAddress for company plans
		const companyPlans = ['Bronz', 'Silver', 'Gold'];
		if (companyPlans.includes(plan.name)) {
			if (!user.regNumber || !user.registeredAddress) {
				console.error(
					`Missing regNumber or registeredAddress for user ${user._id} for company plan ${planName}`
				);
				return next(
					throwError(
						'Pre zakúpenie firemného plánu musíte vyplniť IČO a sídlo spoločnosti.',
						400
					)
				);
			}
		}

		const isFreePlan =
			!user.subscription.planId || user.subscription.planId === 'Free';
		const hasActivePaidPlan =
			!isFreePlan &&
			(user.subscription.status === 'active' ||
				(user.subscription.status === 'canceled' &&
					user.subscription.activeUntil &&
					new Date(user.subscription.activeUntil).setHours(0, 0, 0, 0) >=
						new Date().setHours(0, 0, 0, 0))) &&
			user.subscription.activeUntil &&
			!isNaN(new Date(user.subscription.activeUntil).getTime());

		// Determine trial_end date for pending subscriptions
		let trialEndDate = null;
		let isImmediateActivation = !hasActivePaidPlan;
		if (hasActivePaidPlan && user.subscription.activeUntil) {
			const activeUntil = new Date(user.subscription.activeUntil);
			const now = new Date();
			const threeDaysFromNow = new Date(now);
			threeDaysFromNow.setDate(now.getDate() + 3); // Ensure >2 days
			threeDaysFromNow.setHours(0, 0, 0, 0);

			if (
				activeUntil.setHours(0, 0, 0, 0) < threeDaysFromNow.setHours(0, 0, 0, 0)
			) {
				trialEndDate = threeDaysFromNow;
			} else {
				trialEndDate = activeUntil;
			}
		}

		console.log({
			userId: user._id,
			currentPlan: user.subscription.planId,
			status: user.subscription.status,
			activeUntil: user.subscription.activeUntil,
			isFreePlan,
			hasActivePaidPlan,
			newPlan: planName,
			action: isImmediateActivation ? 'Immediate' : 'Pending',
			trialEndDate,
			pendingSubscription: user.pendingSubscription,
		});

		// Ensure we have a Stripe customer
		let customerId = user.stripeCustomerId;
		if (!customerId) {
			try {
				const customer = await stripe.customers.create({
					email: user.email,
					name: user.username || user.email,
					metadata: { userId: user._id.toString() },
				});
				customerId = customer.id;
				user.stripeCustomerId = customerId;
				await user.save();
				console.log(
					`Created Stripe customer ${customerId} for user ${user._id}`
				);
			} catch (error) {
				console.error(
					`Failed to create Stripe customer for user ${user._id}:`,
					error
				);
				return next(throwError('Failed to create Stripe customer', 500));
			}
		}

		// Create the Stripe Checkout Session
		try {
			const session = await stripe.checkout.sessions.create({
				customer: customerId,
				payment_method_types: ['card'],
				line_items: [
					{
						price: getStripePriceId(plan.name),
						quantity: 1,
					},
				],
				mode: 'subscription',
				subscription_data: trialEndDate
					? {
							trial_end: Math.floor(trialEndDate.getTime() / 1000),
					  }
					: undefined,
				success_url: `${process.env.FRONTEND_URL}/profil?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
				cancel_url: `${process.env.FRONTEND_URL}/profil?subscription=cancel`,
				metadata: { planName },
			});

			// Set pending subscription for active paid plans
			if (!isImmediateActivation) {
				user.pendingSubscription = {
					planId: plan.name,
					subscriptionId: session.subscription || null,
					scheduledActivation: trialEndDate,
				};
				await user.save();
				console.log(
					`Pending subscription set for user ${user._id}:`,
					user.pendingSubscription
				);
				return res.json({
					success: true,
					message: 'Čakajúce predplatné bolo naplánované.',
					pendingSubscription: user.pendingSubscription,
				});
			}

			console.log(
				`Checkout session created for user ${user._id}: sessionId=${session.id}, plan=${planName}`
			);
			return res.json({
				success: true,
				data: { checkoutUrl: session.url },
			});
		} catch (error) {
			console.error(
				`Error creating Stripe checkout session for user ${user._id}:`,
				error
			);
			return next(throwError('Nepodarilo sa vytvoriť checkout session', 500));
		}
	}
);

export const cancelSubscription = catchAsyncErrors(async (req, res, next) => {
	const user = await User.findById(req.user?.id);
	if (!user) {
		console.error(`User not found for id: ${req.user?.id}`);
		return res.status(404).json({
			success: false,
			message: 'Používateľ nenájdený',
		});
	}

	console.log(`Attempting to cancel subscription for user ${user._id}:`, {
		planId: user.subscription.planId,
		status: user.subscription.status,
		activeUntil: user.subscription.activeUntil,
		subscriptionId: user.subscription.subscriptionId,
	});

	// Check if the subscription is active and not Free
	const isPaidPlan =
		user.subscription.planId !== 'Free' &&
		user.subscription.status === 'active';

	if (!isPaidPlan) {
		console.warn(`No active paid subscription found for user ${user._id}`);
		return res.status(400).json({
			success: false,
			message: 'Nenájdené aktívne platené predplatné',
		});
	}

	try {
		const isExpired =
			user.subscription.activeUntil &&
			new Date(user.subscription.activeUntil) <= new Date();

		if (user.subscription.subscriptionId && !isExpired) {
			try {
				await stripe.subscriptions.update(user.subscription.subscriptionId, {
					cancel_at_period_end: true,
				});
				console.log(
					`Stripe subscription ${user.subscription.subscriptionId} set to cancel at period end for user ${user._id}`
				);
			} catch (stripeError) {
				console.error(
					`Failed to update Stripe subscription ${user.subscription.subscriptionId} for user ${user._id}:`,
					{
						type: stripeError.type,
						code: stripeError.code,
						message: stripeError.message,
					}
				);
				// Continue to update database even if Stripe fails
			}
		} else {
			console.warn(
				`No valid subscriptionId or subscription expired for user ${user._id}, marking as canceled in database`
			);
		}

		// Update the database to reflect cancellation
		const updatedUser = await User.findByIdAndUpdate(
			user._id,
			{
				$set: {
					'subscription.status': 'canceled',
					'subscription.activeUntil': user.subscription.activeUntil, // Preserve activeUntil
					'subscription.subscriptionId': isExpired
						? null
						: user.subscription.subscriptionId, // Clear subscriptionId if expired
				},
			},
			{ new: true }
		);

		if (!updatedUser) {
			console.error(`Failed to update user ${user._id} in database`);
			return res.status(500).json({
				success: false,
				message: 'Nepodarilo sa aktualizovať stav predplatného v databáze',
			});
		}

		console.log(
			`Subscription for user ${user._id} marked for cancellation, active until ${user.subscription.activeUntil}`
		);

		return res.json({
			success: true,
			message: 'Predplatné nebude obnovené',
		});
	} catch (error) {
		console.error(`Error canceling subscription for user ${user._id}:`, error);
		return res.status(500).json({
			success: false,
			message: 'Nepodarilo sa zrušiť predplatné',
		});
	}
});

// Terminate a pending subscription
export const terminatePendingSubscription = catchAsyncErrors(
	async (req, res, next) => {
		const user = await User.findById(req.user?.id);
		if (!user) {
			console.error(`User not found for id: ${req.user?.id}`);
			return next(throwError('Používateľ nenájdený', 404));
		}

		if (!user.pendingSubscription || !user.pendingSubscription.planId) {
			console.log(`No pending subscription found for user: ${user._id}`);
			return next(throwError('Žiadne čakajúce predplatné na zrušenie', 400));
		}

		try {
			if (user.pendingSubscription.subscriptionId) {
				await stripe.subscriptions.del(user.pendingSubscription.subscriptionId);

				const subscription = await stripe.subscriptions.retrieve(
					user.pendingSubscription.subscriptionId
				);
				if (subscription.latest_invoice) {
					const invoice = await stripe.invoices.retrieve(
						subscription.latest_invoice
					);
					if (invoice.charge) {
						await stripe.refunds.create({
							charge: invoice.charge,
						});
					}
				}
				console.log(
					`Deleted pending subscription ${user.pendingSubscription.subscriptionId} for user ${user._id}`
				);
			} else {
				console.log(
					`No subscriptionId for pending subscription of user ${user._id}, clearing pendingSubscription`
				);
			}

			user.pendingSubscription = null;
			await user.save();

			console.log(`Pending subscription cleared for user ${user._id}`);
			return res.json({
				success: true,
				message:
					'Čakajúce predplatné bolo zrušené a platba vrátená (ak bola uskutočnená)',
			});
		} catch (error) {
			console.error('Error terminating pending subscription:', error);
			return next(throwError('Nepodarilo sa zrušiť čakajúce predplatné', 500));
		}
	}
);

// Clear a pending subscription on checkout cancel
export const clearPendingSubscription = catchAsyncErrors(
	async (req, res, next) => {
		const user = await User.findById(req.user?.id);
		if (!user) {
			console.error(`User not found for id: ${req.user?.id}`);
			return next(throwError('Používateľ nenájdený', 404));
		}

		if (!user.pendingSubscription || !user.pendingSubscription.planId) {
			console.log(`No pending subscription to clear for user ${user._id}`);
			return res.json({
				success: true,
				message: 'Žiadne čakajúce predplatné na zrušenie',
			});
		}

		try {
			console.log(
				`Clearing pending subscription for user ${user._id}:`,
				user.pendingSubscription
			);
			user.pendingSubscription = null;
			await user.save();
			console.log(
				`Pending subscription cleared for user ${
					user._id
				}: subscription=${JSON.stringify(user.subscription)}, tokens=${
					user.tokens
				}`
			);
			return res.json({
				success: true,
				message: 'Čakajúce predplatné bolo zrušené',
			});
		} catch (error) {
			console.error('Error clearing pending subscription:', error);
			return next(throwError('Nepodarilo sa zrušiť čakajúce predplatné', 500));
		}
	}
);

export const stripePaymentWebhook = catchAsyncErrors(async (req, res, next) => {
	console.log('Webhook received:', {
		headers: req.headers,
		body: req.body.toString(),
		eventType: req.body.type,
	});

	const sig = req.headers['stripe-signature'];
	if (!sig) {
		console.error('Missing Stripe signature header');
		return res.status(400).send('Missing Stripe signature');
	}

	let event;
	try {
		const webHookSecret = process.env.STRIPE_WEBHOOK_SECRET;
		if (!webHookSecret) {
			console.error('Missing STRIPE_WEBHOOK_SECRET environment variable');
			return res.status(400).send('Missing Stripe webhook secret');
		}

		event = stripe.webhooks.constructEvent(req.body, sig, webHookSecret);
		console.log(`Webhook event verified: ${event.type}, ID: ${event.id}`);
	} catch (err) {
		console.error(`Webhook signature verification failed: ${err.message}`);
		return res.status(400).send(`Webhook Error: ${err.message}`);
	}

	// Check if event was already processed
	try {
		const existingEvent = await WebhookEvent.findOne({ eventId: event.id });
		if (existingEvent) {
			console.log(
				`Event ${event.id} already processed at ${existingEvent.processedAt}`
			);
			return res.status(200).send('Webhook received');
		}

		// Mark event as processed
		await WebhookEvent.create({ eventId: event.id });
		console.log(`Marked webhook event ${event.id} as processed`);
	} catch (error) {
		console.error(`Failed to process webhook event ${event.id}:`, error);
		return res.status(500).send('Failed to process webhook event');
	}

	switch (event.type) {
		case 'checkout.session.completed':
			try {
				const session = event.data.object;
				const customerId = session.customer;
				const subscriptionId = session.subscription;
				const planName = session.metadata?.planName;

				// Validate session data
				if (
					!customerId ||
					!subscriptionId ||
					!planName ||
					session.payment_status !== 'paid' ||
					session.status !== 'complete'
				) {
					console.error(
						'Invalid data in checkout.session.completed or session not completed:',
						{
							sessionId: session.id,
							customerId,
							subscriptionId,
							planName,
							payment_status: session.payment_status,
							status: session.status,
						}
					);
					return res.status(400).send('Invalid or incomplete session');
				}

				// Find user by stripeCustomerId
				const user = await User.findOne({ stripeCustomerId: customerId });
				if (!user) {
					console.error(`User not found for customerId: ${customerId}`);
					return res.status(404).send('User not found');
				}

				const plan = getPlanByName(planName);
				if (!plan) {
					console.error(
						`Invalid plan for user ${user._id}: planName=${planName}`
					);
					return res.status(400).send('Invalid plan in session metadata');
				}

				if (plan.name === 'Free') {
					console.warn(
						`Attempt to subscribe to Free plan for user ${user._id}`
					);
					return res
						.status(400)
						.json({ message: 'Free plan cannot be subscribed' });
				}

				const isFreePlan =
					!user.subscription.planId || user.subscription.planId === 'Free';
				const hasActivePaidPlan =
					!isFreePlan &&
					(user.subscription.status === 'active' ||
						(user.subscription.status === 'canceled' &&
							user.subscription.activeUntil &&
							new Date(user.subscription.activeUntil).setHours(0, 0, 0, 0) >=
								new Date().setHours(0, 0, 0, 0))) &&
					user.subscription.activeUntil &&
					!isNaN(new Date(user.subscription.activeUntil).getTime());

				// Determine scheduledActivation date for pending subscriptions
				let isImmediateActivation = !hasActivePaidPlan;
				let scheduledActivation = null;
				if (hasActivePaidPlan && user.subscription.activeUntil) {
					const activeUntil = new Date(user.subscription.activeUntil);
					const now = new Date();
					const threeDaysFromNow = new Date(now);
					threeDaysFromNow.setDate(now.getDate() + 3);
					threeDaysFromNow.setHours(0, 0, 0, 0);

					if (
						activeUntil.setHours(0, 0, 0, 0) <
						threeDaysFromNow.setHours(0, 0, 0, 0)
					) {
						scheduledActivation = threeDaysFromNow;
					} else {
						scheduledActivation = activeUntil;
					}
				}

				console.log({
					userId: user._id,
					currentPlan: user.subscription.planId,
					status: user.subscription.status,
					activeUntil: user.subscription.activeUntil,
					isFreePlan,
					hasActivePaidPlan,
					newPlan: planName,
					action: isImmediateActivation ? 'Immediate' : 'Pending',
					scheduledActivation,
					pendingSubscription: user.pendingSubscription,
				});

				// For users with an active or valid canceled paid plan, set the new plan as pending
				if (!isImmediateActivation) {
					user.pendingSubscription = {
						planId: plan.name,
						subscriptionId: subscriptionId,
						scheduledActivation: scheduledActivation,
					};
					await user.save();
					console.log(
						`Pending subscription ${planName} scheduled for user ${user._id} on ${scheduledActivation}`
					);
					return res.status(200).send('Webhook received');
				}

				// For Free plan or expired plans, activate the new plan immediately
				const activeUntil = new Date();
				activeUntil.setDate(activeUntil.getDate() + 30);

				const tokensForNewPlan = plan.tokensPerMonth || 0;

				const updatedUser = await User.findByIdAndUpdate(
					user._id,
					{
						$set: {
							subscription: {
								planId: plan.name,
								role: plan.role || 'company',
								jobLimit: plan.jobLimit || 1,
								visibilityDays: plan.visibilityDays || 10,
								canTop: plan.canTop || false,
								topDays: plan.topDays || 0,
								tokensPerMonth: plan.tokensPerMonth || 0,
								subscriptionId: subscriptionId,
								status: 'active',
								activeUntil,
							},
							tokens: tokensForNewPlan,
							pendingSubscription: null,
						},
					},
					{ new: true }
				);

				if (!updatedUser) {
					console.error(`Failed to update user ${user._id} in database`);
					return res.status(500).send('Failed to update user subscription');
				}

				console.log(
					`Subscription activated: ${plan.name} (${plan.price} EUR) for user ${updatedUser.email} (${updatedUser._id}) with ${tokensForNewPlan} tokens`
				);
				return res.status(200).send('Webhook received');
			} catch (error) {
				console.error('Error processing checkout.session.completed:', error);
				return res.status(500).send('Internal server error');
			}

		case 'invoice.payment_succeeded':
			try {
				const invoice = event.data.object;
				const subscriptionId = invoice.subscription;

				if (!subscriptionId) {
					console.error(`Missing subscriptionId in invoice: ${invoice.id}`);
					return res.status(400).send('No subscription found in invoice');
				}

				const user = await User.findOne({
					'subscription.subscriptionId': subscriptionId,
				});
				if (!user) {
					console.error(`User not found for subscriptionId: ${subscriptionId}`);
					return res.status(404).send('User not found');
				}

				const plan = getPlanByName(user.subscription.planId);
				if (!plan) {
					console.error(
						`Invalid plan for user ${user._id}: planId=${user.subscription.planId}`
					);
					return res.status(400).send('Invalid plan');
				}

				if (plan.name === 'Free') {
					console.warn(`Attempt to invoice Free plan for user ${user._id}`);
					return res.status(400).json({ message: 'Free plan has no invoices' });
				}

				const tokensForPlan = plan.tokensPerMonth || 0;

				const updatedUser = await User.findByIdAndUpdate(
					user._id,
					{
						$set: {
							subscription: {
								planId: plan.name,
								role: plan.role || 'company',
								jobLimit: plan.jobLimit || 1,
								visibilityDays: plan.visibilityDays || 10,
								canTop: plan.canTop || false,
								topDays: plan.topDays || 0,
								tokensPerMonth: plan.tokensPerMonth || 0,
								subscriptionId: subscriptionId,
								status: 'active',
								activeUntil: new Date(invoice.period_end * 1000),
							},
							tokens: tokensForPlan,
						},
					},
					{ new: true }
				);

				if (!updatedUser) {
					console.error(`Failed to update user ${user._id} in database`);
					return res.status(500).send('Failed to update user subscription');
				}

				console.log(
					`Recurring payment successful: ${plan.name} (${plan.price} EUR) for user ${updatedUser.email} (${updatedUser._id}) with ${tokensForPlan} tokens`
				);
				return res.status(200).send('Webhook received');
			} catch (error) {
				console.error('Error processing invoice.payment_succeeded:', error);
				return res.status(500).send('Internal server error');
			}

		default:
			console.log(`Unhandled event type: ${event.type}`);
			return res.status(200).send('Webhook received');
	}
});
