const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve website files
app.use(express.static(__dirname));

// =====================================================
// ENVIRONMENT VARIABLES
// =====================================================

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

const PORT = process.env.PORT || 10000;

// =====================================================
// M-PESA SANDBOX
// =====================================================

const MPESA_OAUTH_URL =
  "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

const MPESA_STK_URL =
  "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

// =====================================================
// CHECK ENVIRONMENT VARIABLES
// =====================================================

function checkConfiguration() {
  const missing = [];

  if (!MPESA_CONSUMER_KEY) missing.push("MPESA_CONSUMER_KEY");
  if (!MPESA_CONSUMER_SECRET) missing.push("MPESA_CONSUMER_SECRET");
  if (!MPESA_SHORTCODE) missing.push("MPESA_SHORTCODE");
  if (!MPESA_PASSKEY) missing.push("MPESA_PASSKEY");
  if (!MPESA_CALLBACK_URL) missing.push("MPESA_CALLBACK_URL");

  if (missing.length > 0) {
    console.error("Missing environment variables:", missing.join(", "));
    return false;
  }

  return true;
}

// =====================================================
// KENYA TIMESTAMP
// =====================================================

function getTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  })
    .formatToParts(new Date())
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return (
    parts.year +
    parts.month +
    parts.day +
    parts.hour +
    parts.minute +
    parts.second
  );
}

// =====================================================
// NORMALIZE PHONE NUMBER
// =====================================================

function normalizePhone(phone) {
  let number = String(phone || "").replace(/\D/g, "");

  if (number.startsWith("0")) {
    number = "254" + number.substring(1);
  }

  if (number.startsWith("7") || number.startsWith("1")) {
    number = "254" + number;
  }

  return number;
}

// =====================================================
// GET M-PESA ACCESS TOKEN
// =====================================================

async function getMpesaToken() {
  const auth = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(MPESA_OAUTH_URL, {
    headers: {
      Authorization: `Basic ${auth}`
    },
    timeout: 30000
  });

  if (!response.data.access_token) {
    throw new Error("M-PESA access token was not returned.");
  }

  return response.data.access_token;
}

// =====================================================
// STK PUSH
// =====================================================

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    if (!checkConfiguration()) {
      return res.status(500).json({
        success: false,
        message: "M-PESA environment variables are missing."
      });
    }

    const {
      phone,
      amount,
      name,
      orderId,
      accountReference,
      transactionDesc
    } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    if (amount === undefined || amount === null || amount === "") {
      return res.status(400).json({
        success: false,
        message: "Amount is required."
      });
    }

    const phoneNumber = normalizePhone(phone);
    const totalAmount = Math.round(Number(amount));

    // Sandbox test number / Kenyan Safaricom format
    if (!/^2547\d{8}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan Safaricom number."
      });
    }

    if (!Number.isFinite(totalAmount) || totalAmount < 1) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    // Get access token
    const token = await getMpesaToken();

    // Kenya timestamp
    const timestamp = getTimestamp();

    // IMPORTANT:
    // M-PESA STK password is Base64 of:
    // Shortcode + Passkey + Timestamp
    //
    // DO NOT SHA-256 HASH THIS.
    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const stkData = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: totalAmount,
      PartyA: phoneNumber,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phoneNumber,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: accountReference || orderId || "ANANDA",
      TransactionDesc:
        transactionDesc || "Ananda Herbal Products"
    };

    console.log("Sending STK Push...");
    console.log("Shortcode:", MPESA_SHORTCODE);
    console.log("Phone:", phoneNumber);
    console.log("Amount:", totalAmount);
    console.log("Timestamp:", timestamp);
    console.log("Callback URL:", MPESA_CALLBACK_URL);

    const response = await axios.post(
      MPESA_STK_URL,
      stkData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log("STK Push response:", response.data);

    return res.json({
      success: true,
      message:
        response.data.CustomerMessage ||
        "M-PESA payment request sent.",
      data: response.data
    });

  } catch (error) {
    console.error(
      "STK Push error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      message: "Failed to initiate M-PESA payment",
      details: error.response?.data || error.message
    });
  }
});

// =====================================================
// M-PESA CALLBACK
// =====================================================

app.post("/api/mpesa/callback", (req, res) => {
  console.log("=================================");
  console.log("M-PESA CALLBACK RECEIVED");
  console.log("=================================");
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const dataDir = path.join(__dirname, "data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const ordersFile = path.join(dataDir, "orders.json");

    let orders = [];

    if (fs.existsSync(ordersFile)) {
      try {
        orders = JSON.parse(
          fs.readFileSync(ordersFile, "utf8")
        );
      } catch {
        orders = [];
      }
    }

    const callback = req.body?.Body?.stkCallback;

    let payment = {
      receivedAt: new Date().toISOString(),
      checkoutRequestId:
        callback?.CheckoutRequestID || null,
      merchantRequestId:
        callback?.MerchantRequestID || null,
      resultCode:
        callback?.ResultCode ?? null,
      resultDesc:
        callback?.ResultDesc || null,
      callback: req.body
    };

    // Successful payment
    if (Number(callback?.ResultCode) === 0) {
      const items =
        callback?.CallbackMetadata?.Item || [];

      const metadata = {};

      items.forEach((item) => {
        metadata[item.Name] = item.Value;
      });

      payment.mpesaReceipt =
        metadata.MpesaReceiptNumber || null;

      payment.amount =
        metadata.Amount || null;

      payment.phone =
        metadata.PhoneNumber || null;

      payment.transactionDate =
        metadata.TransactionDate || null;

      console.log("PAYMENT SUCCESSFUL");
      console.log("Receipt:", payment.mpesaReceipt);
      console.log("Amount:", payment.amount);
    } else {
      console.log("PAYMENT FAILED OR CANCELLED");
    }

    orders.push(payment);

    fs.writeFileSync(
      ordersFile,
      JSON.stringify(orders, null, 2)
    );

  } catch (error) {
    console.error(
      "Callback save error:",
      error.message
    );
  }

  return res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Ananda server is running",
    mpesaConfigured: checkConfiguration()
  });
});

// =====================================================
// WEBSITE FALLBACK
// =====================================================

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Ananda server running on port ${PORT}`
  );
  console.log("M-PESA environment: SANDBOX");
});
