/**
 * Billing API Routes
 *
 * Stripe subscription management including checkout, portal, and webhooks.
 */

import { Router } from 'express';
import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { verifyUserJWT } from '../middleware/userAuth.js';

const router = Router();

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Subscription tier limits
const TIER_LIMITS = {
  free: 0,
  starter: 1,
  pro: 3,
  unlimited: 10
};

// Price IDs from Stripe Dashboard (env vars)
const PRICE_MAP = {
  starter: {
    month: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID,
    year: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID
  },
  pro: {
    month: process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    year: process.env.STRIPE_PRO_ANNUAL_PRICE_ID
  },
  unlimited: {
    month: process.env.STRIPE_UNLIMITED_MONTHLY_PRICE_ID,
    year: process.env.STRIPE_UNLIMITED_ANNUAL_PRICE_ID
  }
};

/**
 * POST /api/v1/billing/create-checkout-session
 * Create Stripe Checkout session for subscription
 */
router.post('/create-checkout-session', verifyUserJWT, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Billing service not configured' });
    }

    const { tier, interval } = req.body; // tier: starter|pro|unlimited, interval: month|year
    if (!PRICE_MAP[tier]?.[interval]) {
      return res.status(400).json({ error: 'Invalid tier or interval' });
    }

    const priceId = PRICE_MAP[tier][interval];
    if (!priceId) {
      return res.status(400).json({ error: `Price not configured for ${tier} ${interval}` });
    }

    // Get or create Stripe customer
    let customerId = req.user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name: req.user.name || undefined,
        metadata: { userId: req.user._id.toString() }
      });
      customerId = customer.id;
      await req.db.collection('User').updateOne(
        { _id: req.user._id },
        { $set: { stripeCustomerId: customerId, updatedAt: new Date() } }
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL || 'https://klik.cool'}/dashboard?subscription=success`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://klik.cool'}/pricing?subscription=canceled`,
      metadata: { userId: req.user._id.toString(), tier },
      subscription_data: { metadata: { userId: req.user._id.toString(), tier } }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

/**
 * POST /api/v1/billing/create-portal-session
 * Create Stripe Customer Portal session for subscription management
 */
router.post('/create-portal-session', verifyUserJWT, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Billing service not configured' });
    }

    if (!req.user.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: req.user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL || 'https://klik.cool'}/settings/billing`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

/**
 * GET /api/v1/billing/subscription
 * Get current subscription details
 */
router.get('/subscription', verifyUserJWT, async (req, res) => {
  try {
    const sub = {
      status: req.user.subscriptionStatus || 'inactive',
      tier: req.user.subscriptionTier || 'free',
      endDate: req.user.subscriptionEndDate,
      agentLimit: TIER_LIMITS[req.user.subscriptionTier] || 0
    };

    // Get payment method info from Stripe
    if (stripe && req.user.stripeCustomerId && req.user.subscriptionStatus === 'active') {
      try {
        const customer = await stripe.customers.retrieve(req.user.stripeCustomerId, {
          expand: ['subscriptions.data', 'invoice_settings.default_payment_method']
        });
        const pm = customer.invoice_settings?.default_payment_method;
        if (pm && typeof pm === 'object') {
          sub.paymentMethod = { brand: pm.card?.brand, last4: pm.card?.last4 };
        }
        const activeSub = customer.subscriptions?.data?.[0];
        if (activeSub) {
          sub.cancelAtPeriodEnd = activeSub.cancel_at_period_end;
          sub.currentPeriodEnd = new Date(activeSub.current_period_end * 1000);
        }
      } catch (stripeErr) {
        console.error('Stripe fetch error:', stripeErr.message);
      }
    }

    res.json(sub);
  } catch (err) {
    console.error('Subscription fetch error:', err);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

/**
 * POST /api/v1/billing/webhook
 * Stripe webhook handler
 *
 * IMPORTANT: This route MUST use express.raw(), NOT express.json()
 * Configure this in index.js BEFORE the global json middleware
 */
router.post('/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Billing service not configured' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = req.db;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const tier = session.metadata?.tier;
        if (userId && tier) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await db.collection('User').updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                subscriptionId: session.subscription,
                subscriptionStatus: 'active',
                subscriptionTier: tier,
                subscriptionEndDate: new Date(subscription.current_period_end * 1000),
                updatedAt: new Date()
              }
            }
          );
          console.log(`Subscription activated: user=${userId}, tier=${tier}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        if (userId) {
          const tier = subscription.metadata?.tier || 'free';
          await db.collection('User').updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                subscriptionStatus: subscription.status,
                subscriptionTier: subscription.status === 'active' ? tier : 'free',
                subscriptionEndDate: new Date(subscription.current_period_end * 1000),
                updatedAt: new Date()
              }
            }
          );
          console.log(`Subscription updated: user=${userId}, status=${subscription.status}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        if (userId) {
          await db.collection('User').updateOne(
            { _id: new ObjectId(userId) },
            {
              $set: {
                subscriptionStatus: 'canceled',
                subscriptionTier: 'free',
                updatedAt: new Date()
              }
            }
          );
          // Pause all user's agents
          await db.collection('Agent').updateMany(
            { userId: new ObjectId(userId), status: 'ACTIVE' },
            { $set: { status: 'PAUSED', updatedAt: new Date() } }
          );
          console.log(`Subscription canceled: user=${userId}, agents paused`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const user = await db.collection('User').findOne({ stripeCustomerId: customerId });
        if (user) {
          await db.collection('User').updateOne(
            { _id: user._id },
            { $set: { subscriptionStatus: 'past_due', updatedAt: new Date() } }
          );
          console.log(`Payment failed: user=${user._id}`);
          // TODO: Send warning email
        }
        break;
      }

      default:
        console.log(`Unhandled webhook event: ${event.type}`);
    }
  } catch (err) {
    console.error(`Webhook handler error for ${event.type}:`, err);
    // Return 200 to acknowledge receipt - Stripe will retry on error
  }

  res.json({ received: true });
});

export default router;
