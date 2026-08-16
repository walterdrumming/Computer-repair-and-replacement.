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

// ---------------------------------------------------------------------
// Look up what's actually owed on a ticket. NEVER trust an amount sent
// from the browser — always resolve it server-side against your own
// records (a database, your ticketing system, etc). This stub stands
// in for that lookup.
// ---------------------------------------------------------------------
function getTicketBalanceCents(ticketId) {
  const TICKETS = {
    'IC-40217': 23900, // $239.00
  };
  if (!TICKETS[ticketId]) throw new Error('Unknown ticket');
  return TICKETS[ticketId];
}

// =======================================================================
// STRIPE — Card / debit / credit via the Payment Element
// =======================================================================

app.post('/api/stripe/create-payment-intent', async (req, res) => {
  try {
    const { ticketId } = req.body;
    const amount = getTicketBalanceCents(ticketId);

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { ticket_id: ticketId },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// =======================================================================
// PAYPAL — Orders v2 API
// =======================================================================

const PAYPAL_BASE =
  process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  return data.access_token;
}

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { ticketId } = req.body;
    const amountCents = getTicketBalanceCents(ticketId);
    const accessToken = await getPayPalAccessToken();

    const resp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: ticketId,
            amount: {
              currency_code: 'USD',
              value: (amountCents / 100).toFixed(2),
            },
          },
        ],
      }),
    });
    const order = await resp.json();
    res.json({ id: order.id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/paypal/capture-order/:orderId', async (req, res) => {
  try {
    const accessToken = await getPayPalAccessToken();
    const resp = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${req.params.orderId}/capture`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const capture = await resp.json();
    // TODO: verify capture.status === 'COMPLETED' and mark the ticket paid,
    // using capture.purchase_units[0].reference_id as the ticket id.
    res.json(capture);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// =======================================================================
// CRYPTO — Coinbase Commerce hosted checkout
// =======================================================================

app.post('/api/crypto/create-charge', async (req, res) => {
  try {
    const { ticketId } = req.body;
    const amountCents = getTicketBalanceCents(ticketId);

    const resp = await fetch('https://api.commerce.coinbase.com/charges', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Api-Key': process.env.COINBASE_COMMERCE_API_KEY,
        'X-CC-Version': '2018-03-22',
      },
      body: JSON.stringify({
        name: `Fast Computer Repair — Ticket ${ticketId}`,
        description: 'Device repair balance',
        pricing_type: 'fixed_price',
        local_price: { amount: (amountCents / 100).toFixed(2), currency: 'USD' },
        metadata: { ticket_id: ticketId },
        redirect_url: process.env.SITE_URL + '/paid.html',
        cancel_url: process.env.SITE_URL + '/#pay',
      }),
    });
    const charge = await resp.json();
    res.json({ hostedUrl: charge.data.hosted_url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.post(
  '/api/crypto/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const signature = req.headers['x-cc-webhook-signature'];
    const hmac = crypto
      .createHmac('sha256', process.env.COINBASE_COMMERCE_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

    if (signature !== hmac) {
      return res.status(400).send('Invalid signature');
    }

    const event = JSON.parse(req.body).event;
    if (event.type === 'charge:confirmed') {
      const ticketId = event.data.metadata.ticket_id;
      // TODO: mark the ticket in your database as PAID
      console.log(`✅ Crypto payment confirmed for ticket ${ticketId}`);
    }
    res.json({ received: true });
  }
);

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`Fast Computer Repair payment server listening on :${port}`));
