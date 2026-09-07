```javascript
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Website files are in the ROOT of the GitHub repository
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, '[]');
}

function readOrders() {
  try {
    return JSON.parse(
      fs.readFileSync(ORDERS_FILE, 'utf8')
    );
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(
    ORDERS_FILE,
    JSON.stringify(orders, null, 2)
  );
}

function nowStamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
    .formatToParts(new Date())
    .reduce((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});

  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');

  if (p.startsWith('0')) {
    p = '254' + p.slice(1);
  }

  if (p.startsWith('7')) {
    p = '254' + p;
  }

  return p;
}

function env(name) {
  const v = process.env[name];

  if (!v) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return v;
}

async function mpesaToken() {
  const key = env('MPESA_CONSUMER_KEY');
  const secret = env('MPESA_CONSUMER_SECRET');

  const base =
    process.env.MPESA_ENVIRONMENT === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke';

  const auth = Buffer.from(
    `${key}:${secret}`
  ).toString('base64');

  const r = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  const data = await r.json();

  if (!r.ok || !data.access_token) {
    throw new Error(
      data.errorMessage ||
      'Could not get M-PESA access token'
    );
  }

  return {
    token: data.access_token,
    base
  };
}

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      address,
      city,
      items,
      amount
    } = req.body || {};

    const msisdn = normalizePhone(phone);
    const total = Math.round(Number(amount));

    if (
      !name ||
      !address ||
      !city ||
      !/^2547\d{8}$/.test(msisdn)
    ) {
      return res.status(400).json({
        error:
          'Please provide a valid Kenyan Safaricom number and complete delivery details.'
      });
    }

    if (!Number.isFinite(total) || total < 1) {
      return res.status(400).json({
        error: 'Invalid order amount.'
      });
    }

    const { token, base } = await mpesaToken();

    const timestamp = nowStamp();
    const shortcode = env('MPESA_SHORTCODE');
    const passkey = env('MPESA_PASSKEY');

    const password = Buffer.from(
      `${shortcode}${passkey}${timestamp}`
    ).toString('base64');

    const callbackBase =
      env('MPESA_CALLBACK_URL').replace(/\/$/, '');

    const orderId =
      `AN-${Date.now()}-${crypto
        .randomBytes(3)
        .toString('hex')
        .toUpperCase()}`;

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,

      TransactionType:
        process.env.MPESA_TRANSACTION_TYPE ||
        'CustomerPayBillOnline',

      Amount: total,
      PartyA: msisdn,
      PartyB: shortcode,
      PhoneNumber: msisdn,

      CallBackURL:
        `${callbackBase}/api/mpesa/callback`,

      AccountReference: orderId.slice(0, 12),
      TransactionDesc: 'ANANDA order'
    };

    const r = await fetch(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        method: 'POST',

        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },

        body: JSON.stringify(payload)
      }
    );

    const data = await r.json();

    if (!r.ok || data.ResponseCode !== '0') {
      console.error(
        'M-PESA STK error',
        data
      );

      return res.status(502).json({
        error:
          data.errorMessage ||
          data.ResponseDescription ||
          'M-PESA payment request failed.'
      });
    }

    const orders = readOrders();

    orders.push({
      orderId,
      name,
      phone: msisdn,
      email: email || '',
      address,
      city,

      items:
        Array.isArray(items)
          ? items
          : [],

      amount: total,
      status: 'pending',

      merchantRequestId:
        data.MerchantRequestID,

      checkoutRequestId:
        data.CheckoutRequestID,

      createdAt:
        new Date().toISOString()
    });

    writeOrders(orders);

    res.json({
      orderId,

      customerMessage:
        data.CustomerMessage ||
        'Check your phone and enter your M-PESA PIN to complete payment.'
    });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error:
        e.message ||
        'Payment service is not configured.'
    });
  }
});

app.post('/api/mpesa/callback', (req, res) => {
  try {
    const callback =
      req.body?.Body?.stkCallback;

    if (!callback) {
      return res.json({
        ResultCode: 0,
        ResultDesc: 'Accepted'
      });
    }

    const orders = readOrders();

    const idx =
      orders.findIndex(
        o =>
          o.checkoutRequestId ===
          callback.CheckoutRequestID
      );

    if (idx >= 0) {
      const order = orders[idx];

      order.status =
        Number(callback.ResultCode) === 0
          ? 'paid'
          : 'failed';

      order.resultCode =
        callback.ResultCode;

      order.resultDesc =
        callback.ResultDesc;

      if (
        Number(callback.ResultCode) === 0
      ) {
        const md =
          Object.fromEntries(
            (
              callback
                .CallbackMetadata
                ?.Item || []
            ).map(
              x => [x.Name, x.Value]
            )
          );

        order.mpesaReceipt =
          md.MpesaReceiptNumber || '';

        order.paidAmount =
          md.Amount || order.amount;

        order.transactionPhone =
          md.PhoneNumber || order.phone;

        order.paidAt =
          new Date().toISOString();
      }

      writeOrders(orders);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

  } catch (e) {
    console.error(
      'Callback error',
      e
    );

    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const order =
    readOrders().find(
      o =>
        o.orderId ===
        req.params.id
    );

  if (!order) {
    return res.status(404).json({
      error: 'Order not found'
    });
  }

  res.json({
    orderId: order.orderId,

    status:
      order.status,

    receipt:
      order.mpesaReceipt ||
      null,

    message:
      order.resultDesc ||
      null
  });
});

// Serve index.html from the ROOT of the repository
app.get('/{*splat}', (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      'index.html'
    )
  );
});

app.listen(PORT, () => {
  console.log(
    `ANANDA website running on port ${PORT}`
  );
});
```
