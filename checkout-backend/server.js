// ============================================================
//  Practice Time — Backend Server
//
//  ⚠️  GOING LIVE CHECKLIST:
//  1. In Stripe Dashboard → Developers → API Keys:
//     - Copy your sk_live_... key → set as STRIPE_SECRET_KEY env var on Render
//     - Copy your pk_live_... key → paste in checkout.html STRIPE_PK
//  2. In Stripe Dashboard → Developers → Webhooks:
//     - Update webhook endpoint to https://cole-2.onrender.com/webhook
//     - Copy the live webhook signing secret → set as STRIPE_WEBHOOK_SECRET env var
//  3. Redeploy on Render after updating env vars
//  Deploy on Render: https://cole-2.onrender.com
//
//  UPDATED PRICES: PracticeTag $39.99, Software $18.99
// ============================================================

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Prices (in cents) ────────────────────────────────────────
// IMPORTANT: These must match what the frontend sends.
// Frontend CONFIG.PRICES = { physical: 3999, software: 1899 }
const PRICES = {
  physical: 3999,  // $39.99 — PracticeTag NFC Card
  software: 1899,  // $18.99 — Software Bundle
};

// ── Middleware ───────────────────────────────────────────────
app.use(cors());

// Stripe webhook needs raw body — mount BEFORE express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    console.log('Payment succeeded:', pi.id, 'amount:', pi.amount);
    // Fulfillment logic handled in frontend (claimProvisioningCode, recordPhysicalOrder)
  }

  res.json({ received: true });
});

app.use(express.json());

// ── POST /create-payment-intent ──────────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, email, name, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    // Server-side price validation — always use server PRICES, never trust client
    let total = 0;
    for (const item of items) {
      const unitPrice = PRICES[item.type];
      if (!unitPrice) return res.status(400).json({ error: `Unknown item type: ${item.type}` });
      const qty = Math.max(1, Math.min(10, parseInt(item.qty) || 1));
      total += unitPrice * qty;
    }

    if (total < 50) {
      return res.status(400).json({ error: 'Order total too low.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:   total,
      currency: 'usd',
      metadata: {
        email:   email   || '',
        name:    name    || '',
        address: address || '',
        items:   JSON.stringify(items),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /send-receipt ───────────────────────────────────────
app.post('/send-receipt', async (req, res) => {
  try {
    const { email, name, code, items, total } = req.body;
    if (!email) return res.status(400).json({ error: 'No email provided.' });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_FROM,
        pass: process.env.EMAIL_APP_PASSWORD,
      },
    });

    const hasPhysical = items?.some(i => i.type === 'physical');
    const hasSoftware = items?.some(i => i.type === 'software');

    const itemLines = (items || [])
      .map(i => `<tr>
        <td style="padding:8px 0;color:#b8b4cc">${i.qty}× ${i.type === 'physical' ? 'PracticeTag NFC Card' : 'Software Bundle'}</td>
        <td style="padding:8px 0;text-align:right;color:#f0ede8">$${((i.price || PRICES[i.type]) / 100 * i.qty).toFixed(2)}</td>
      </tr>`)
      .join('');

    const codeSection = code ? `
      <div style="background:#0a1a0a;border:1px solid rgba(74,222,128,.3);border-radius:12px;padding:20px;margin:24px 0;text-align:center">
        <p style="font-size:12px;color:#4ade80;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px">Your Provisioning Code</p>
        <p style="font-size:28px;font-weight:800;color:#f0ede8;letter-spacing:.2em;margin:0">${code}</p>
        <p style="font-size:13px;color:#6b6880;margin-top:12px;margin-bottom:0">Open Practice Time → Account → Redeem Code</p>
      </div>` : '';

    const shippingSection = hasPhysical ? `
      <div style="background:#1a1006;border:1px solid rgba(251,146,60,.2);border-radius:12px;padding:16px;margin:16px 0">
        <p style="font-size:14px;color:#fb923c;margin:0"><strong>📦 Shipping:</strong> Your PracticeTag will be dispatched within 3–5 business days. You'll receive a tracking email when it ships.</p>
      </div>` : '';

    await transporter.sendMail({
      from:    `Practice Time <${process.env.EMAIL_FROM}>`,
      to:      email,
      subject: 'Your Practice Time Receipt',
      html: `
<!DOCTYPE html><html><body style="background:#06060e;color:#f0ede8;font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
  <h1 style="font-size:28px;letter-spacing:-.03em;margin-bottom:4px">Practice<span style="color:#4ade80">Time</span></h1>
  <p style="color:#6b6880;font-size:14px;margin-bottom:32px">Order confirmed</p>
  <h2 style="font-size:20px;margin-bottom:4px">Thanks${name ? ', ' + name.split(' ')[0] : ''}!</h2>
  <p style="color:#9490aa;font-size:15px">Your payment was successful.</p>
  ${codeSection}
  ${shippingSection}
  <table style="width:100%;border-top:1px solid rgba(255,255,255,.07);margin:24px 0 0">${itemLines}
    <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,.07);padding-top:12px"></td></tr>
    <tr>
      <td style="padding:4px 0;font-weight:700;color:#f0ede8">Total</td>
      <td style="padding:4px 0;text-align:right;font-weight:700;color:#4ade80">$${(total / 100).toFixed(2)}</td>
    </tr>
  </table>
  <p style="margin-top:32px;font-size:13px;color:#6b6880">Questions? Reply to this email or contact <a href="mailto:support@practicetimeapp.com" style="color:#4ade80">support@practicetimeapp.com</a>.</p>
</body></html>`,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('send-receipt error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── POST /refund ─────────────────────────────────────────────
app.post('/refund', async (req, res) => {
  try {
    const { paymentId, amount, reason } = req.body;
    if (!paymentId) return res.status(400).json({ error: 'No paymentId provided.' });

    const refundParams = {
      payment_intent: paymentId,
      reason: reason || 'requested_by_customer',
    };
    // If amount is provided (partial refund), include it; otherwise full refund
    if (amount && amount > 0) {
      refundParams.amount = amount; // in cents
    }

    const refund = await stripe.refunds.create(refundParams);

    console.log('Refund created:', refund.id, 'amount:', refund.amount, 'status:', refund.status);
    res.json({ ok: true, refundId: refund.id, amount: refund.amount, status: refund.status });
  } catch (err) {
    console.error('Refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', prices: PRICES }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Practice Time server running on port ${PORT}`));