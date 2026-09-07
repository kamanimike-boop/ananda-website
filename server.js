const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the website files from the repository root
app.use(express.static(__dirname));

// M-PESA environment variables
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// =====================================================
// M-PESA SANDBOX ENDPOINTS
// =====================================================

const MPESA_OAUTH_URL =
  "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

const MPESA_STK_URL =
  "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

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
    }
  });

  return response.data.access_token;
}

// =====================================================
// M-PESA STK PUSH
// =====================================================

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    const { phone, amount, name } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        message: "Phone number and amount are required"
      });
    }

    let phoneNumber = String(phone).replace(/\s+/g, "");

    // Convert Kenyan formats to 254XXXXXXXXX
    if (phoneNumber.startsWith("07")) {
      phoneNumber = "254" + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith("01")) {
      phoneNumber = "254" + phoneNumber.substring(1);
    } else if (phoneNumber.startsWith("+254")) {
      phoneNumber = phoneNumber.substring(1);
    }

    const token = await getMpesaToken();

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .substring(0, 14);

    const password = crypto
      .createHash("sha256")
      .update(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`)
      .digest("base64");

    const stkData = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Number(amount),
      PartyA: phoneNumber,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phoneNumber,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: "ANANDA",
      TransactionDesc: `Ananda payment${name ? ` - ${name}` : ""}`
    };

    const response = await axios.post(MPESA_STK_URL, stkData, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    console.log("STK Push response:", response.data);

    res.json({
      success: true,
      message: "M-PESA payment request sent",
      data: response.data
    });

  } catch (error) {
    console.error(
      "STK Push error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      message: "Failed to initiate M-PESA payment",
      error: error.response?.data || error.message
    });
  }
});

// =====================================================
// M-PESA CALLBACK
// =====================================================

app.post("/api/mpesa/callback", (req, res) => {
  console.log("M-PESA CALLBACK RECEIVED:");
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
        orders = JSON.parse(fs.readFileSync(ordersFile, "utf8"));
      } catch {
        orders = [];
      }
    }

    orders.push({
      receivedAt: new Date().toISOString(),
      callback: req.body
    });

    fs.writeFileSync(
      ordersFile,
      JSON.stringify(orders, null, 2)
    );

  } catch (error) {
    console.error("Callback save error:", error);
  }

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

// =====================================================
// WEBSITE FALLBACK
// =====================================================

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// =====================================================
// START SERVER
// =====================================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Ananda website running on port ${PORT}`);
});
