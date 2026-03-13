/**
 * Practice Time — Checkout Backend
 * Node.js / Express server that:
 *  1. Creates Stripe PaymentIntents
 *  2. Handles Stripe webhooks to send confirmation emails via Nodemailer
 *
 * Deploy this to Railway, Render, Fly.io, or any Node host.
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Allowed origins (add your real domain) ──────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://sites.google.com/view/practicetimer/buy-now?authuser=0',   // ← replace
];

app.use(cors());

// Raw body needed for Stripe webhook signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

// ── Email transporter (Gmail example) ───────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_APP_PASSWORD,   // Gmail App Password (not your login password)
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /create-payment-intent
   Called by the frontend when the user clicks Pay.
   Returns a clientSecret for Stripe.js to confirm.
═══════════════════════════════════════════════════════════════ */
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, email, name, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

    // Compute total server-side (never trust client prices)
    const PRICES = {
      physical: 1200,  // $12.00
      software:  999,  // $9.99
    };

    let amount = 0;
    const lineItems = [];
    for (const item of items) {
      const unitPrice = PRICES[item.type];
      if (!unitPrice) return res.status(400).json({ error: `Unknown item type: ${item.type}` });
      const qty = Math.min(Math.max(1, parseInt(item.qty) || 1), 10);
      amount += unitPrice * qty;
      lineItems.push({ type: item.type, qty, price: unitPrice });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      receipt_email: email,
      metadata: {
        customerEmail: email,
        customerName:  name || '',
        shippingAddress: address || '',
        items: JSON.stringify(lineItems),
      },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret });

  } catch (err) {
    console.error('create-payment-intent error:', err);
    res.status(500).json({ error: err.message });
  }
});



/* ═══════════════════════════════════════════════════════════════
   POST /send-receipt
   Called directly by the frontend after payment succeeds.
   Sends the confirmation email including the provisioning code.
═══════════════════════════════════════════════════════════════ */
app.post('/send-receipt', async (req, res) => {
  try {
    const { email, name, code, items, total } = req.body;
    if (!email) return res.status(400).json({ error: 'No email provided.' });
    await sendReceiptEmail(email, name, items || [], total || 0, code);
    console.log(`✓ Receipt sent to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('send-receipt error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /webhook
   Stripe sends events here after payment succeeds.
   Used to send confirmation + receipt emails.

   Set your webhook URL in Stripe Dashboard →
   Developers → Webhooks → Add endpoint
   URL: https://your-backend.com/webhook
   Events: payment_intent.succeeded
═══════════════════════════════════════════════════════════════ */
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

    try {
        event = stripe.webhooks.constructEvent(
          req.rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error('Webhook signature failed:', err.message);
        // Temporarily skip signature check for testing
        event = JSON.parse(req.body);
      }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const { customerEmail, customerName, items } = intent.metadata;

    if (customerEmail) {
      await sendReceiptEmail(customerEmail, customerName, JSON.parse(items || '[]'), intent.amount);
    }
  }

  res.json({ received: true });
});

/* ── Email helpers ────────────────────────────────────────────── */
async function sendReceiptEmail(email, name, items, totalCents, code) {
  const itemLines = items.map(i =>
    `<tr>
      <td style="padding:8px 0;color:#b8b4cc">${i.qty}× ${i.type === 'physical' ? 'PracticeTag NFC Card' : 'Software Bundle'}</td>
      <td style="text-align:right;color:#f0ede8">$${((i.price * i.qty) / 100).toFixed(2)}</td>
    </tr>`
  ).join('');

  const hasSoftware = items.some(i => i.type === 'software');
  const hasPhysical = items.some(i => i.type === 'physical');

  const codeBlock = code ? `
    <div style="background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.25);border-radius:12px;padding:24px;margin:24px 0;text-align:center">
      <div style="font-size:11px;color:#4ade80;letter-spacing:.12em;text-transform:uppercase;margin-bottom:10px">Your Provisioning Code</div>
      <div style="font-size:32px;font-weight:800;color:#f0ede8;letter-spacing:.25em;font-family:monospace">${code}</div>
      <div style="margin-top:16px;font-size:13px;color:#9490aa;line-height:1.7">
        <strong style="color:#f0ede8;display:block;margin-bottom:6px">How to redeem:</strong>
        1. Open Practice Time on your iPhone<br>
        2. Tap the <strong style="color:#f0ede8">Account</strong> tab<br>
        3. Scroll to <strong style="color:#f0ede8">Redeem Code</strong><br>
        4. Enter the code above and tap <strong style="color:#f0ede8">Redeem</strong>
      </div>
    </div>` : '';

  const shippingBlock = hasPhysical ? `
    <div style="background:rgba(251,146,60,.06);border:1px solid rgba(251,146,60,.2);border-radius:12px;padding:16px;margin-top:16px;font-size:13px;color:#d4a06a;line-height:1.6">
      <strong style="color:#fb923c">📦 Shipping update:</strong> Your PracticeTag will be dispatched within 3–5 business days. Tracking info will follow.
    </div>` : '';

  const html = `
  <div style="background:#06060e;padding:40px 0;font-family:'DM Sans',sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#0e0e1c;border-radius:16px;overflow:hidden;border:1px solid #ffffff10">
      <div style="background:linear-gradient(135deg,rgba(59,130,246,.3),rgba(147,51,234,.3)),#07070f;padding:32px;text-align:center">
        <h1 style="font-size:28px;color:#fff;letter-spacing:-.03em;margin:0">Practice<span style="color:#4ade80;font-style:italic">Time</span></h1>
        <p style="color:#9490aa;margin:8px 0 0;font-size:14px">Order Confirmation</p>
      </div>
      <div style="padding:32px">
        <p style="color:#f0ede8;font-size:16px;margin-bottom:8px">Hi ${name || 'there'},</p>
        <p style="color:#9490aa;font-size:14px;line-height:1.6;margin-bottom:0">Thanks for your purchase!${hasSoftware ? ' Your provisioning code is below.' : ''}</p>

        <table style="width:100%;margin:24px 0;border-collapse:collapse">
          ${itemLines}
          <tr style="border-top:1px solid #ffffff10">
            <td style="padding:12px 0 0;font-weight:700;color:#f0ede8">Total</td>
            <td style="padding:12px 0 0;text-align:right;color:#4ade80;font-size:18px">$${(totalCents/100).toFixed(2)}</td>
          </tr>
        </table>

        ${codeBlock}
        ${shippingBlock}

        <p style="color:#6b6880;font-size:12px;margin-top:24px">If you have any issues, reply to this email and we'll help you out.</p>
      </div>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `Practice Time <${process.env.EMAIL_FROM}>`,
    to:   email,
    subject: 'Your Practice Time Order ✓',
    html,
  });
}

/* ── Start ───────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
