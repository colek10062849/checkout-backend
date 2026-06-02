/**
 * Practice Time — Backend Server
 * Node.js / Express
 *
 * Endpoints:
 *   POST /create-payment-intent  — creates Stripe PaymentIntent
 *   POST /send-receipt           — sends order confirmation email
 *   POST /refund                 — issues Stripe refund + deactivates code
 *   POST /contact                — stores support message (fallback)
 *   POST /webhook                — Stripe webhook (payment events)
 *   GET  /                       — health check (GET)
 *   HEAD /                       — health check (HEAD — for UptimeRobot)
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Stripe     = require('stripe');
const nodemailer = require('nodemailer');

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Firebase Admin (for webhook-triggered code revocation) ──────
// Set FIREBASE_SERVICE_ACCOUNT env var on Render as the JSON string
// of your Firebase service account key.
let adminDb = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : null;
    if (sa) {
      admin.initializeApp({ credential: admin.credential.cert(sa) });
      adminDb = admin.firestore();
      console.log('✓ Firebase Admin initialized');
    } else {
      console.warn('FIREBASE_SERVICE_ACCOUNT not set — revocation webhooks disabled');
    }
  } else {
    adminDb = admin.firestore();
  }
} catch (e) {
  console.warn('Firebase Admin not available:', e.message);
}

// ── Prices (in cents) ───────────────────────────────────────────
const PRICES = {
  physical: 2999,   // $29.99 — PracticeTag NFC Card
  software: 1899,   // $18.99 — Software Bundle
};

// ── CORS ────────────────────────────────────────────────────────
app.use(cors());

// ── Body parsing (raw for webhook, JSON for everything else) ────
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { req.rawBody = data; next(); });
  } else {
    express.json()(req, res, next);
  }
});

// ── Email transporter ───────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_APP_PASSWORD,
  }
});

// ── Health check ────────────────────────────────────────────────
// GET for browsers/curl, HEAD for UptimeRobot
app.get('/',  (req, res) => res.json({ status: 'ok', service: 'Practice Time API', prices: PRICES }));
app.head('/', (req, res) => res.status(200).end());

/* ═══════════════════════════════════════════════════════════════
   POST /create-payment-intent
   Frontend calls this when user clicks Pay.
   Returns clientSecret for Stripe.js.
═══════════════════════════════════════════════════════════════ */
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { items, email, name, address } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided.' });
    }

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
        customerEmail:   email        || '',
        customerName:    name         || '',
        shippingAddress: address      || '',
        items:           JSON.stringify(lineItems),
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
   Fire-and-forget email after successful payment.
   Called by frontend — does NOT block the success screen.
═══════════════════════════════════════════════════════════════ */
app.post('/send-receipt', async (req, res) => {
  try {
    const { email, name, code, items, total } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email.' });
    await sendReceiptEmail(email, name, code, items || [], total || 0);
    res.json({ ok: true });
  } catch (err) {
    console.error('send-receipt error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /refund
   Admin panel calls this to issue a full or partial refund.
   Also marks the provisioning code as deactivated in Firestore.
═══════════════════════════════════════════════════════════════ */
app.post('/refund', async (req, res) => {
  try {
    const { paymentIntentId, amount, reason, orderId, orderType, customerEmail } = req.body;
    if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId.' });

    // Retrieve the PaymentIntent to get the charge ID
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const chargeId = pi.latest_charge;
    if (!chargeId) return res.status(400).json({ error: 'No charge found for this PaymentIntent.' });

    // Issue the refund
    const refundParams = { charge: chargeId };
    if (amount) refundParams.amount = Math.round(amount * 100); // dollars → cents
    if (reason) refundParams.reason = reason; // 'duplicate' | 'fraudulent' | 'requested_by_customer'

    const refund = await stripe.refunds.create(refundParams);

    // If software order — deactivate code and trigger app-side revocation via Firestore
    if (orderType === 'software' && orderId && adminDb) {
      try {
        await adminDb.collection('provisioningCodes').doc(orderId).update({
          isActive:          false,
          refunded:          true,
          deactivatedAt:     new Date().toISOString(),
          deactivatedReason: 'refunded',
        });

        if (customerEmail) {
          const usersSnap = await adminDb.collection('users')
            .where('email', '==', customerEmail).limit(1).get();
          if (!usersSnap.empty) {
            await usersSnap.docs[0].ref.update({ pendingRevokeCode: orderId });
            console.log('Revocation queued for:', customerEmail);
          }
        }
      } catch (fbErr) {
        console.warn('Firestore revocation during refund failed:', fbErr.message);
      }
    }

    res.json({ ok: true, refundId: refund.id, status: refund.status });
  } catch (err) {
    console.error('refund error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /contact
   Fallback if Firestore write fails on the contact page.
   Logs the message server-side.
═══════════════════════════════════════════════════════════════ */
app.post('/contact', async (req, res) => {
  try {
    const { email, message } = req.body;
    if (!email || !message) return res.status(400).json({ error: 'Missing email or message.' });
    console.log(`[Contact] From: ${email} | Message: ${message.slice(0, 100)}`);

    // Optionally store in Firestore if admin is available
    if (adminDb) {
      await adminDb.collection('contactSubmissions').add({
        email,
        message,
        sentAt: new Date().toISOString(),
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('contact error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════
   POST /webhook
   Stripe sends payment events here.
   Events to subscribe in Stripe Dashboard:
     • payment_intent.succeeded
     • payment_intent.payment_failed
     • charge.refunded
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
    return res.status(400).json({ error: 'Webhook signature verification failed.' });
  }

  // ── payment_intent.succeeded ──────────────────────────────────
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    console.log('Payment succeeded:', pi.id, '| amount:', pi.amount);

    // Mark payment confirmed in Firestore
    if (adminDb) {
      try {
        const codesSnap = await adminDb.collection('provisioningCodes')
          .where('paymentId', '==', pi.id).limit(1).get();
        if (!codesSnap.empty) {
          await codesSnap.docs[0].ref.update({
            paymentConfirmed: true,
            paymentStatus:    'paid',
          });
        }
      } catch (e) { console.warn('Webhook Firestore update failed:', e.message); }
    }
  }

  // ── payment_intent.payment_failed ────────────────────────────
  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    console.log('Payment FAILED:', pi.id);

    if (adminDb) {
      try {
        const codesSnap = await adminDb.collection('provisioningCodes')
          .where('paymentId', '==', pi.id).limit(1).get();

        if (!codesSnap.empty) {
          const codeDoc  = codesSnap.docs[0];
          const codeData = codeDoc.data();
          const soldTo   = codeData.soldTo || codeData.redeemedBy;

          await codeDoc.ref.update({
            paymentStatus:     'failed',
            isActive:          false,
            deactivatedAt:     new Date().toISOString(),
            deactivatedReason: 'payment_failed',
          });

          // Queue revocation on user document
          if (soldTo) {
            const usersSnap = await adminDb.collection('users')
              .where('email', '==', soldTo).limit(1).get();
            if (!usersSnap.empty) {
              await usersSnap.docs[0].ref.update({ pendingRevokeCode: codeDoc.id });
              console.log('Revocation queued for:', soldTo);
            }
          }
        }
      } catch (e) { console.warn('Payment failed webhook error:', e.message); }
    }
  }

  // ── charge.refunded ───────────────────────────────────────────
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    console.log('Charge refunded:', charge.id, '| pi:', charge.payment_intent);

    if (adminDb && charge.payment_intent) {
      try {
        const codesSnap = await adminDb.collection('provisioningCodes')
          .where('paymentId', '==', charge.payment_intent).limit(1).get();

        if (!codesSnap.empty) {
          const codeDoc  = codesSnap.docs[0];
          const codeData = codeDoc.data();

          await codeDoc.ref.update({
            refunded:          true,
            paymentStatus:     'refunded',
            isActive:          false,
            deactivatedAt:     new Date().toISOString(),
            deactivatedReason: 'refunded',
          });

          if (codeData.soldTo) {
            const usersSnap = await adminDb.collection('users')
              .where('email', '==', codeData.soldTo).limit(1).get();
            if (!usersSnap.empty) {
              await usersSnap.docs[0].ref.update({ pendingRevokeCode: codeDoc.id });
            }
          }
        }
      } catch (e) { console.warn('Refund webhook error:', e.message); }
    }
  }

  res.json({ received: true });
});

/* ═══════════════════════════════════════════════════════════════
   Email helper
═══════════════════════════════════════════════════════════════ */
async function sendReceiptEmail(email, name, code, items, totalCents) {
  const itemLines = items.map(i =>
    `<tr>
      <td style="padding:8px 0;color:#b8b4cc">${i.qty}× ${i.type === 'physical' ? 'PracticeTag NFC Card' : 'Software Bundle'}</td>
      <td style="text-align:right;color:#f0ede8">$${((i.price * i.qty) / 100).toFixed(2)}</td>
    </tr>`
  ).join('');

  const hasSoftware = items.some(i => i.type === 'software');
  const codeBlock   = (hasSoftware && code) ? `
    <div style="background:#06060e;border:1px solid #4ade8033;border-radius:12px;padding:20px;margin:20px 0;text-align:center">
      <p style="color:#9490aa;font-size:12px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.1em">Your Provisioning Code</p>
      <p style="color:#4ade80;font-size:24px;font-weight:700;letter-spacing:.15em;margin:0">${code}</p>
      <p style="color:#6b6880;font-size:12px;margin:8px 0 0">Enter this in Practice Time → Account → Redeem Code</p>
    </div>` : '';

  const html = `
  <div style="background:#06060e;padding:40px 0;font-family:'DM Sans',sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#0e0e1c;border-radius:16px;overflow:hidden;border:1px solid #ffffff10">
      <div style="background:linear-gradient(135deg,rgba(59,130,246,.3),rgba(147,51,234,.3)),#07070f;padding:32px;text-align:center">
        <h1 style="font-size:28px;color:#fff;letter-spacing:-.03em;margin:0">Practice<span style="color:#4ade80;font-style:italic">Time</span></h1>
        <p style="color:#9490aa;margin:8px 0 0;font-size:14px">Order Confirmation</p>
      </div>
      <div style="padding:32px">
        <p style="color:#f0ede8;font-size:16px">Hi ${name || 'there'},</p>
        <p style="color:#9490aa;font-size:14px;line-height:1.6">
          Thanks for your purchase!
          ${hasSoftware ? 'Your provisioning code is below — enter it in the app to unlock your features.' : ''}
          ${items.some(i => i.type === 'physical') ? 'Your PracticeTag will ship within 3–5 business days.' : ''}
        </p>
        ${codeBlock}
        <table style="width:100%;margin:24px 0;border-collapse:collapse">
          ${itemLines}
          <tr style="border-top:1px solid #ffffff10">
            <td style="padding:12px 0 0;font-weight:700;color:#f0ede8">Total</td>
            <td style="padding:12px 0 0;text-align:right;color:#4ade80;font-size:18px">$${(totalCents / 100).toFixed(2)}</td>
          </tr>
        </table>
        <p style="color:#6b6880;font-size:12px;margin-top:24px">
          Questions? Email us at <a href="mailto:support@practicetime.org" style="color:#4ade80">support@practicetime.org</a>
        </p>
      </div>
    </div>
  </div>`;

  await transporter.sendMail({
    from:    `Practice Time <${process.env.EMAIL_FROM}>`,
    to:      email,
    subject: 'Your Practice Time Order ✓',
    html,
  });

  console.log('Receipt sent to:', email);
}

/* ═══════════════════════════════════════════════════════════════
   Start
═══════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✓ Practice Time server running on port ${PORT}`));