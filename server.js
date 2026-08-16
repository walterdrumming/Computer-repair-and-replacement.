// Ironclad Repair — payment backend
// Handles Stripe (cards), PayPal, and Coinbase Commerce (crypto)
//
// Run: npm install && npm start
// Requires Node 18+ (uses built-in fetch)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Stripe webhooks need the RAW body for signature verification,
// so that route is registered BEFORE the json() body parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      // TODO: mark the ticket in your database as PAID using pi.metadata.ticket_id
      console.log(`✅ Stripe payment succeeded for ticket ${pi.metadata.ticket_id}`);
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      console.log(`❌ Stripe payment failed for ticket ${pi.metadata.ticket_id}`);
      break;
    }
  }
  res.json({ received: true });
});

app.use(cors());
app.use(express.json());
