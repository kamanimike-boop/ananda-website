const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve website files from the repository root
app.use(express.static(__dirname));

// -----------------------------
// Configuration
// -----------------------------

const PORT = process.env.PORT || 3000;

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

const ORDERS_FILE = path.join(__dirname, "data", "orders.json");

// Make sure data folder exists
if (!fs.existsSync(path.dirname(ORDERS_FILE))) {
  fs.mkdirSync(path.dirname(ORDERS_FILE), { recursive: true });
}

// Make sure orders file exists
if (!fs.existsSync(ORDERS_FILE)) {
  fs.writeFileSync(ORDERS_FILE, "[]");
}

// -----------------------------
// Helper functions
// -----------------------------

function loadOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch (error) {
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function getTimestamp() {
  const now = new Date();

  const parts = {
    year: now.getFullYear(),
    month: String(now.getMonth() + 1).padStart(2, "0"),
    day: String(now.getDate()).padStart(2, "0"),
    hour: String(now.getHours()).padStart(2, "0"),
    minute: String(now.getMinutes()).padStart(2, "0"),
    second: String(now.getSeconds()).padStart(2, "0")
  };

  return (
    String(parts.year) +
    String(parts.month) +
    String(parts.day) +
    String(parts.hour) +
    String(parts.minute) +
    String(parts.second)
  );
}

function requiredEnv(name, value) {
  if (!value) {
    throw new Error("Missing environment variable: " + name);
  }

  return value;
}

// -----------------------------
// M-PESA access token
// -----------------------------

async function getMpesaToken() {
  const key = requiredEnv("MPESA_CONSUMER_KEY", MPESA_CONSUMER_KEY);
  const secret = requiredEnv(
    "MPESA_CONSUMER_SECRET",
    MPESA_CONSUMER_SECRET
  );

  const auth = Buffer.from(key + ":" + secret).toString("base64");

  const response = await axios.get(
    "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + auth
      }
    }
  );

  return response.data.access_token;
}

// -----------------------------
// STK Push
// -----------------------------

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const {
      phone,
      amount,
      orderId,
      accountReference,
      transactionDesc
    } = req.body;

    const token = await getMpesaToken();

    const shortcode = requiredEnv("MPESA_SHORTCODE", MPESA_SHORTCODE);
    const passkey = requiredEnv("MPESA_PASSKEY", MPESA_PASSKEY);
    const callbackUrl = requiredEnv(
      "MPESA_CALLBACK_URL",
      MPESA_CALLBACK_URL
    );

    const timestamp = getTimestamp();

    const password = Buffer.from(
      shortcode + passkey + timestamp
    ).toString("base64");

    const response = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Number(amount),
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: accountReference || orderId || "ANANDA",
        TransactionDesc:
          transactionDesc || "Ananda Herbal Products"
      },
      {
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error(
      "STK Push error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      error: "Failed to initiate M-PESA payment",
      details: error.response?.data || error.message
    });
  }
});

// -----------------------------
// M-PESA callback
// -----------------------------

app.post("/api/mpesa/callback", (req, res) => {
  try {
    console.log(
      "M-PESA callback:",
      JSON.stringify(req.body, null, 2)
    );

    const callback =
      req.body?.Body?.stkCallback;

    if (callback) {
      const resultCode = callback.ResultCode;
      const resultDesc = callback.ResultDesc;

      console.log("M-PESA ResultCode:", resultCode);
      console.log("M-PESA ResultDesc:", resultDesc);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  } catch (error) {
    console.error("Callback error:", error);

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

// -----------------------------
// Orders
// -----------------------------

app.post("/api/orders", (req, res) => {
  try {
    const orders = loadOrders();

    const order = {
      id:
        "AN-" +
        Date.now() +
        "-" +
        crypto.randomBytes(3).toString("hex").toUpperCase(),
      ...req.body,
      createdAt: new Date().toISOString()
    };

    orders.push(order);
    saveOrders(orders);

    res.json({
      success: true,
      order
    });
  } catch (error) {
    console.error("Order error:", error);

    res.status(500).json({
      success: false,
      error: "Could not save order"
    });
  }
});

app.get("/api/orders", (req, res) => {
  res.json(loadOrders());
});

// -----------------------------
// Website fallback
// -----------------------------

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// -----------------------------
// Start server
// -----------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("Ananda server running on port " + PORT);
});
