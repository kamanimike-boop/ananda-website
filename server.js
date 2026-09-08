```javascript
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

// ==========================================
// BASIC EXPRESS SETUP
// ==========================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve website files
app.use(express.static(__dirname));

// ==========================================
// M-PESA CONFIGURATION
// ==========================================

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

// Daraja Sandbox
const MPESA_BASE_URL = "https://sandbox.safaricom.co.ke";

// ==========================================
// ORDERS STORAGE
// ==========================================

const dataDir = path.join(__dirname, "data");
const ordersFile = path.join(dataDir, "orders.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(ordersFile, "[]");
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  } catch (error) {
    console.error("Could not read orders:", error);
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(
    ordersFile,
    JSON.stringify(orders, null, 2)
  );
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    message: "ANANDA server is running",
    mpesaConfigured: Boolean(
      MPESA_CONSUMER_KEY &&
      MPESA_CONSUMER_SECRET &&
      MPESA_SHORTCODE &&
      MPESA_PASSKEY &&
      MPESA_CALLBACK_URL
    )
  });
});

// ==========================================
// KENYA TIMESTAMP
// ==========================================

function getKenyaTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return (
    values.year +
    values.month +
    values.day +
    values.hour +
    values.minute +
    values.second
  );
}

// ==========================================
// PHONE NUMBER NORMALIZATION
// ==========================================

function normalizePhone(phone) {
  if (!phone) {
    return null;
  }

  let value = String(phone).trim();

  value = value.replace(/\s+/g, "");
  value = value.replace(/-/g, "");
  value = value.replace(/^\+/, "");

  if (value.startsWith("07") || value.startsWith("01")) {
    value = "254" + value.substring(1);
  }

  if (value.startsWith("7") || value.startsWith("1")) {
    value = "254" + value;
  }

  if (!/^254[17]\d{8}$/.test(value)) {
    return null;
  }

  return value;
}

// ==========================================
// GET M-PESA ACCESS TOKEN
// ==========================================

async function getAccessToken() {
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    throw new Error(
      "MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is missing"
    );
  }

  // IMPORTANT:
  // Do NOT use a template literal here.
  // Do NOT hash the credentials.
  const credentials = Buffer.from(
    MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET
  ).toString("base64");

  const response = await axios.get(
    MPESA_BASE_URL + "/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + credentials
      },
      timeout: 30000
    }
  );

  return response.data.access_token;
}

// ==========================================
// M-PESA STK PUSH
// ==========================================

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    console.log("=================================");
    console.log("M-PESA STK PUSH REQUEST");
    console.log("=================================");

    const {
      name,
      phone,
      email,
      address,
      city,
      items,
      amount,
      orderId,
      accountReference,
      transactionDesc
    } = req.body;

    console.log("Customer:", name);
    console.log("Phone received:", phone);
    console.log("Amount:", amount);
    console.log("Order ID:", orderId);

    if (!MPESA_SHORTCODE || !MPESA_PASSKEY || !MPESA_CALLBACK_URL) {
      return res.status(500).json({
        error: "M-PESA configuration is incomplete"
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({
        error: "Invalid Kenyan phone number"
      });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "Invalid payment amount"
      });
    }

    const accessToken = await getAccessToken();

    const timestamp = getKenyaTimestamp();

    // Correct Daraja password:
    // Base64(Shortcode + Passkey + Timestamp)
    // DO NOT SHA-256 HASH THIS.
    const password = Buffer.from(
      MPESA_SHORTCODE +
      MPESA_PASSKEY +
      timestamp
    ).toString("base64");

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(numericAmount),
      PartyA: normalizedPhone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: normalizedPhone,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: String(
        accountReference || orderId || "ANANDA"
      ).substring(0, 12),
      TransactionDesc: String(
        transactionDesc || "ANANDA Herbal Products"
      ).substring(0, 20)
    };

    console.log("STK Payload:");
    console.log({
      BusinessShortCode: payload.BusinessShortCode,
      Timestamp: payload.Timestamp,
      TransactionType: payload.TransactionType,
      Amount: payload.Amount,
      PartyA: payload.PartyA,
      PartyB: payload.PartyB,
      PhoneNumber: payload.PhoneNumber,
      CallBackURL: payload.CallBackURL,
      AccountReference: payload.AccountReference,
      TransactionDesc: payload.TransactionDesc
    });

    const response = await axios.post(
      MPESA_BASE_URL + "/mpesa/stkpush/v1/processrequest",
      payload,
      {
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log("STK Push response:", response.data);

    const checkoutRequestId =
      response.data.CheckoutRequestID;

    const merchantRequestId =
      response.data.MerchantRequestID;

    // Save pending order
    const orders = readOrders();

    orders.push({
      orderId: orderId || null,
      merchantRequestId: merchantRequestId || null,
      checkoutRequestId: checkoutRequestId || null,

      name: name || "",
      phone: normalizedPhone,
      email: email || "",
      address: address || "",
      city: city || "",

      items: items || [],
      amount: Math.round(numericAmount),

      status: "PENDING",

      resultCode: null,
      resultDesc: null,
      mpesaReceiptNumber: null,

      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    writeOrders(orders);

    return res.json({
      success: true,
      message: response.data.CustomerMessage ||
        "STK Push sent successfully",

      merchantRequestId: merchantRequestId,
      checkoutRequestId: checkoutRequestId,

      responseCode: response.data.ResponseCode,
      responseDescription: response.data.ResponseDescription
    });

  } catch (error) {
    console.error("=================================");
    console.error("STK PUSH ERROR");
    console.error("=================================");

    if (error.response) {
      console.error(
        "M-PESA response:",
        error.response.data
      );

      return res.status(
        error.response.status || 500
      ).json({
        success: false,
        error:
          error.response.data?.errorMessage ||
          error.response.data?.ResponseDescription ||
          "M-PESA STK Push failed"
      });
    }

    console.error("Error:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message || "STK Push failed"
    });
  }
});

// ==========================================
// M-PESA CALLBACK
// ==========================================

app.post("/api/mpesa/callback", (req, res) => {
  console.log("");
  console.log("=================================");
  console.log("M-PESA CALLBACK RECEIVED");
  console.log("=================================");

  console.log(
    JSON.stringify(req.body, null, 2)
  );

  try {
    const callback =
      req.body?.Body?.stkCallback;

    if (!callback) {
      console.log("No stkCallback found.");

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const merchantRequestId =
      callback.MerchantRequestID;

    const checkoutRequestId =
      callback.CheckoutRequestID;

    const resultCode =
      callback.ResultCode;

    const resultDesc =
      callback.ResultDesc;

    let receiptNumber = null;
    let transactionDate = null;
    let phoneNumber = null;
    let amount = null;

    if (Array.isArray(callback.CallbackMetadata?.Item)) {
      const metadata =
        callback.CallbackMetadata.Item;

      for (const item of metadata) {
        if (item.Name === "MpesaReceiptNumber") {
          receiptNumber = item.Value;
        }

        if (item.Name === "TransactionDate") {
          transactionDate = item.Value;
        }

        if (item.Name === "PhoneNumber") {
          phoneNumber = item.Value;
        }

        if (item.Name === "Amount") {
          amount = item.Value;
        }
      }
    }

    const orders = readOrders();

    const orderIndex = orders.findIndex(
      order =>
        order.checkoutRequestId ===
        checkoutRequestId
    );

    if (orderIndex !== -1) {
      orders[orderIndex].resultCode = resultCode;
      orders[orderIndex].resultDesc = resultDesc;
      orders[orderIndex].updatedAt =
        new Date().toISOString();

      if (resultCode === 0) {
        orders[orderIndex].status = "PAID";
        orders[orderIndex].mpesaReceiptNumber =
          receiptNumber;

        orders[orderIndex].transactionDate =
          transactionDate;

        orders[orderIndex].paidPhone =
          phoneNumber;

        orders[orderIndex].paidAmount =
          amount;

        console.log("=================================");
        console.log("PAYMENT SUCCESSFUL");
        console.log("=================================");
        console.log(
          "M-PESA Receipt:",
          receiptNumber
        );
        console.log(
          "Amount:",
          amount
        );
        console.log(
          "Phone:",
          phoneNumber
        );
      } else {
        orders[orderIndex].status = "FAILED";

        console.log("=================================");
        console.log("PAYMENT FAILED OR CANCELLED");
        console.log("=================================");
        console.log(
          "ResultCode:",
          resultCode
        );
        console.log(
          "ResultDesc:",
          resultDesc
        );
      }

      writeOrders(orders);
    } else {
      console.log(
        "No matching order found for CheckoutRequestID:",
        checkoutRequestId
      );
    }

  } catch (error) {
    console.error(
      "Callback processing error:",
      error
    );
  }

  // Always acknowledge the M-PESA callback.
  return res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});

// ==========================================
// CHECK PAYMENT STATUS
// ==========================================

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  (req, res) => {
    try {
      const checkoutRequestId =
        req.params.checkoutRequestId;

      const orders = readOrders();

      const order = orders.find(
        item =>
          item.checkoutRequestId ===
          checkoutRequestId
      );

      if (!order) {
        return res.status(404).json({
          success: false,
          status: "NOT_FOUND",
          message: "Payment record not found"
        });
      }

      return res.json({
        success: true,
        status: order.status,
        orderId: order.orderId,
        amount: order.amount,
        resultCode: order.resultCode,
        resultDesc: order.resultDesc,
        mpesaReceiptNumber:
          order.mpesaReceiptNumber || null,
        transactionDate:
          order.transactionDate || null
      });

    } catch (error) {
      console.error(
        "Payment status error:",
        error
      );

      return res.status(500).json({
        success: false,
        error: "Could not check payment status"
      });
    }
  }
);

// ==========================================
// VIEW ORDERS
// ==========================================

app.get("/api/orders", (req, res) => {
  try {
    const orders = readOrders();

    return res.json({
      success: true,
      count: orders.length,
      orders: orders
    });

  } catch (error) {
    console.error(
      "Orders error:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Could not load orders"
    });
  }
});

// ==========================================
// FRONTEND FALLBACK
// EXPRESS 5 COMPATIBLE
// ==========================================

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("=================================");
  console.log("ANANDA SERVER STARTED");
  console.log("=================================");
  console.log("Port:", PORT);
  console.log(
    "M-PESA configured:",
    Boolean(
      MPESA_CONSUMER_KEY &&
      MPESA_CONSUMER_SECRET &&
      MPESA_SHORTCODE &&
      MPESA_PASSKEY &&
      MPESA_CALLBACK_URL
    )
  );
  console.log(
    "Callback URL:",
    MPESA_CALLBACK_URL
  );
  console.log("=================================");
});
```
