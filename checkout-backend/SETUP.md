# Practice Time Checkout — Complete Setup Guide

## Overview of what you have

| File | Purpose |
|---|---|
| `checkout.html` | The storefront — embed on your website |
| `checkout-backend/server.js` | Node.js server — handles payments |
| `checkout-backend/.env.example` | Environment variables template |

---

## STEP 1 — Firebase setup

You already have Firebase in your iOS app. The checkout page uses the same
Firestore database to claim provisioning codes.

### 1a. Add `isSold` field to your provisioning codes

Your existing codes have these fields:
```
provisioningCodes/{CODE}
  features: ["practiceTimer", "sustainAI", "history", "store", "recording"]
  isRedeemed: bool
  plan: "full"
  createdAt: Timestamp
```

You need to add `isSold: false` to every unsold code so the checkout page can
query for available ones. Run this one-time script from your `admin/` folder:

```bash
# In your existing admin/ folder:
node -e "
const admin = require('firebase-admin');
const svc = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();
async function run() {
  const snap = await db.collection('provisioningCodes').get();
  let count = 0;
  for (const doc of snap.docs) {
    if (doc.data().isSold === undefined) {
      await doc.ref.update({ isSold: false });
      count++;
    }
  }
  console.log('Updated', count, 'codes');
  process.exit(0);
}
run();
"
```

### 1b. Add a Firestore index

The checkout queries:
  collection: provisioningCodes
  where: isRedeemed == false AND isSold == false AND plan == 'full'

Go to Firebase Console → Firestore → Indexes → Add composite index:
  Collection: provisioningCodes
  Fields: isRedeemed (Ascending), isSold (Ascending), plan (Ascending)

OR just run the checkout once — Firebase will print a direct link to create
the index automatically when the query fails.

### 1c. Firestore Security Rules

Add this rule so the checkout page (unauthenticated) can claim codes:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Existing app rules (keep these)
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth.uid == uid;
    }

    // Allow checkout page to read + update provisioning codes
    // (only isSold/soldTo/soldAt/paymentId fields can be written)
    match /provisioningCodes/{code} {
      allow read: if resource.data.isRedeemed == false
                  && resource.data.isSold == false;
      allow update: if request.resource.data.diff(resource.data).affectedKeys()
                      .hasOnly(['isSold','soldTo','soldAt','paymentId'])
                    && request.resource.data.isSold == true;
    }
  }
}
```

### 1d. Put your Firebase config in checkout.html

Replace the placeholder block near the top of checkout.html:

```js
const firebaseConfig = {
  apiKey:            "AIzaSy...",
  authDomain:        "your-project.firebaseapp.com",
  projectId:         "your-project-id",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:abc123"
};
```

Get this from: Firebase Console → Project Settings → Your apps → Web app
(Add a web app if you don't have one yet — the iOS app uses a different config).

---

## STEP 2 — Stripe setup

### 2a. Create a Stripe account
Go to https://stripe.com and create an account.
Complete identity verification to accept live payments.

### 2b. Get your API keys
Dashboard → Developers → API keys
- **Publishable key** (pk_live_... or pk_test_...) → goes in checkout.html
- **Secret key** (sk_live_...) → goes in your backend .env

### 2c. Put your publishable key in checkout.html

```js
const CONFIG = {
  STRIPE_PK: 'pk_live_YOUR_KEY_HERE',   // ← replace
  BACKEND_URL: 'https://your-backend.com',  // ← your deployed backend URL
  ...
};
```

---

## STEP 3 — Deploy the backend

### Option A: Railway (easiest, ~$5/mo)

1. Go to https://railway.app, create account
2. New Project → Deploy from GitHub repo
   (push checkout-backend/ to a GitHub repo first)
3. Add environment variables (copy from .env.example, fill real values)
4. Railway gives you a URL like `https://yourapp.railway.app`
5. Put that URL in checkout.html as `BACKEND_URL`

### Option B: Render (free tier available)

1. Go to https://render.com
2. New → Web Service → Connect GitHub
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Add environment variables in the Render dashboard
6. Copy the `https://yourapp.onrender.com` URL to checkout.html

### Option C: Local dev (testing only)

```bash
cd checkout-backend
cp .env.example .env
# Fill in your .env values
npm install
npm run dev
# Server runs at http://localhost:3001
```

For testing locally, use your `pk_test_` and `sk_test_` Stripe keys.
Stripe test card: `4242 4242 4242 4242`, any future date, any CVC.

---

## STEP 4 — Set up Stripe webhook

The webhook fires after payment succeeds and triggers the confirmation email.

1. Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://your-backend.com/webhook`
3. Events to listen for: `payment_intent.succeeded`
4. After creating, reveal the **Signing secret** (whsec_...)
5. Add it to your .env as `STRIPE_WEBHOOK_SECRET`
6. Redeploy your backend

---

## STEP 5 — Set up email

The backend uses Gmail to send receipt emails.

1. Use a dedicated Gmail account (e.g. orders@yourdomain.com or yourapp.orders@gmail.com)
2. Enable 2-Factor Authentication on that account
3. Go to https://myaccount.google.com/apppasswords
4. Create an App Password for "Mail"
5. Copy the 16-character password into .env as `EMAIL_APP_PASSWORD`
6. Set `EMAIL_FROM` to that Gmail address

---

## STEP 6 — Put checkout.html on your site

### If you have a plain HTML website:
Just upload checkout.html and link to it: `<a href="/checkout.html">Buy</a>`

### If you use Webflow:
1. Add a new page
2. Embed → Custom Code → paste the full contents of checkout.html into the
   page's `<head>` and `<body>` sections

### If you use Squarespace / Wix:
Upload checkout.html to your hosting (e.g. GitHub Pages or Netlify) and
link to it from your main site.

### Recommended: Netlify (free)
```bash
# Drop checkout.html into a folder, then:
npx netlify-cli deploy --prod --dir=.
```

---

## STEP 7 — Test the full flow

1. Use Stripe test keys (pk_test_ / sk_test_)
2. Make sure your Firebase has at least one code with:
   `{ isRedeemed: false, isSold: false, plan: 'full' }`
3. Open checkout.html in a browser
4. Add both items to cart, click Checkout
5. Use test card: `4242 4242 4242 4242` | Any future date | Any CVC
6. After payment:
   - Code should appear on screen
   - The code doc in Firestore should show `isSold: true`
   - A receipt email should arrive
7. Test redeeming the code in the iOS app (Account → Redeem Code)

---

## Stock management

The checkout page pulls codes from your existing `provisioningCodes` collection.
Use your existing `admin/generate-codes.js` to top up stock:

```bash
cd admin
node generate-codes.js --count 100 --plan full --out new-batch.csv
```

Each code generated has `isSold: false, isRedeemed: false` by default
(you may need to add `isSold: false` to your generate script — add this line
inside the code object before writing to Firestore):

In generate-codes.js, find where you set the Firestore document data and add:
```js
isSold: false,
```

---

## Pricing

Change prices in two places to keep them in sync:

1. **checkout.html** — `CONFIG.PRICES` (in cents):
```js
PRICES: {
  physical: 1200,  // $12.00
  software:  999,  // $9.99
}
```

2. **server.js** — `PRICES` object (same values):
```js
const PRICES = {
  physical: 1200,
  software:  999,
};
```

The server always re-validates the price server-side so clients can't
manipulate it.

---

## Security checklist

- [x] Server validates prices (not trusting client)
- [x] Stripe webhook signature verified
- [x] Firebase rules limit what checkout can write
- [x] No secret keys in checkout.html (only publishable key)
- [x] CORS restricted to your domain in server.js
- [x] Provisioning codes only marked sold, not redeemed (user still must enter in app)
