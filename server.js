```javascript
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve ANANDA website
app.use(express.static(__dirname));

/* =========================================================
   M-PESA CONFIGURATION
   ========================================================= */

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || "174379";
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL =
  process.env.MPESA_CALLBACK_URL ||
  "https://ananda-mpesa-test.onrender.com/api/mpesa/callback";

const MPESA_OAUTH_URL =
  "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

const MPESA_STK_URL =
  "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

/* =========================================================
   PAYMENT STORAGE
   ========================================================= */

const dataDir = path.join(__dirname, "data");
const ordersFile = path.join(dataDir, "orders.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(ordersFile, "[]", "utf8");
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ordersFile, "utf8"));
  } catch (error) {
    console.error("Could not read orders:", error);
    return [];
  }
}

function saveOrders(orders) {
  fs.writeFileSync(
    ordersFile,
    JSON.stringify(orders, null, 2),
    "utf8"
  );
}

/* =========================================================
   KENYA TIMESTAMP
   ========================================================= */

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

  const get = (type) =>
    parts.find((part) => part.type === type)?.value || "";

  return (
    get("year") +
    get("month") +
    get("day") +
    get("hour") +
    get("minute") +
    get("second")
  );
}

/* =========================================================
   PHONE NUMBER NORMALIZATION
   ========================================================= */

function normalizePhone(phone) {
  let value = String(phone || "").replace(/\D/g, "");

  if (value.startsWith("0")) {
    value = "254" + value.substring(1);
  }

  if (value.startsWith("7")) {
    value = "254" + value;
  }

  if (value.startsWith("254")) {
    return value;
  }

  return value;
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "ANANDA M-PESA",
    environment: "sandbox",
    shortcode: MPESA_SHORTCODE,
    callbackUrl: MPESA_CALLBACK_URL
  });
});

/* =========================================================
   GET M-PESA ACCESS TOKEN
   ========================================================= */

async function getAccessToken() {
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    throw new Error(
      "M-PESA consumer key or consumer secret is missing."
    );
  }

  const credentials = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(MPESA_OAUTH_URL, {
    headers: {
      Authorization: `Basic ${credentials}`
    },
    timeout: 30000
  });

  if (!response.data.access_token) {
    throw new Error("M-PESA did not return an access token.");
  }

  return response.data.access_token;
}

/* =========================================================
   STK PUSH
   ========================================================= */

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
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

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required."
      });
    }

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "A valid payment amount is required."
      });
    }

    if (!MPESA_PASSKEY) {
      return res.status(500).json({
        success: false,
        message: "M-PESA passkey is missing from Render environment variables."
      });
    }

    const normalizedPhone = normalizePhone(phone);

    if (!/^2547\d{8}$/.test(normalizedPhone)) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid Kenyan Safaricom number, for example 0712345678."
      });
    }

    const timestamp = getKenyaTimestamp();

    /*
      IMPORTANT:
      M-PESA STK password is Base64 of:

      BusinessShortCode + Passkey + Timestamp

      DO NOT SHA-256 HASH THIS.
    */
    const password = Buffer.from(
      `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
    ).toString("base64");

    const token = await getAccessToken();

    const payload = {
      BusinessShortCode: Number(MPESA_SHORTCODE),

      Password: password,

      Timestamp: timestamp,

      TransactionType: "CustomerPayBillOnline",

      Amount: Math.round(Number(amount)),

      PartyA: normalizedPhone,

      PartyB: Number(MPESA_SHORTCODE),

      PhoneNumber: normalizedPhone,

      CallBackURL: MPESA_CALLBACK_URL,

      AccountReference: String(
        accountReference || orderId || "ANANDA"
      ).substring(0, 12),

      TransactionDesc: String(
        transactionDesc || "ANANDA Herbal Products"
      ).substring(0, 20)
    };

    console.log("");
    console.log("=================================");
    console.log("M-PESA STK PUSH REQUEST");
    console.log("=================================");
    console.log("Timestamp:", timestamp);
    console.log("Phone:", normalizedPhone);
    console.log("Amount:", payload.Amount);
    console.log("Shortcode:", MPESA_SHORTCODE);
    console.log("Callback URL:", MPESA_CALLBACK_URL);
    console.log("=================================");

    const response = await axios.post(
      MPESA_STK_URL,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log("");
    console.log("STK Push response:", response.data);

    /*
      Save the order immediately as PENDING.
    */
    const orders = readOrders();

    orders.push({
      orderId: orderId || `ANANDA-${Date.now()}`,
      name: name || "",
      phone: normalizedPhone,
      email: email || "",
      address: address || "",
      city: city || "",
      items: Array.isArray(items) ? items : [],
      amount: Math.round(Number(amount)),
      merchantRequestId: response.data.MerchantRequestID || "",
      checkoutRequestId: response.data.CheckoutRequestID || "",
      status: "PENDING",
      createdAt: new Date().toISOString()
    });

    saveOrders(orders);

    return res.json({
      success: true,
      message:
        response.data.CustomerMessage ||
        "STK Push sent. Check your phone.",
      customerMessage:
        response.data.CustomerMessage ||
        "Please check your phone for the M-PESA prompt.",
      MerchantRequestID: response.data.MerchantRequestID,
      CheckoutRequestID: response.data.CheckoutRequestID,
      checkoutRequestId: response.data.CheckoutRequestID
    });

  } catch (error) {
    console.error("");

    console.error("=================================");
    console.error("STK PUSH ERROR");
    console.error("=================================");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else {
      console.error("Message:", error.message);
    }

    console.error("=================================");

    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.errorMessage ||
        error.response?.data?.message ||
        error.message ||
        "M-PESA STK Push failed."
    });
  }
});

/* =========================================================
   M-PESA CALLBACK
   ========================================================= */

app.post("/api/mpesa/callback", (req, res) => {
  try {
    console.log("");
    console.log("=================================");
    console.log("M-PESA CALLBACK RECEIVED");
    console.log("=================================");

    console.log(
      JSON.stringify(req.body, null, 2)
    );

    const callback =
      req.body?.Body?.stkCallback;

    if (!callback) {
      console.log("Invalid callback received.");
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    const checkoutRequestId =
      callback.CheckoutRequestID || "";

    const merchantRequestId =
      callback.MerchantRequestID || "";

    const resultCode =
      callback.ResultCode;

    const resultDesc =
      callback.ResultDesc || "";

    const orders = readOrders();

    const orderIndex = orders.findIndex(
      (order) =>
        order.checkoutRequestId === checkoutRequestId
    );

    let paymentData = {};

    /*
      Successful payment.
    */
    if (Number(resultCode) === 0) {
      const metadata =
        callback.CallbackMetadata?.Item || [];

      metadata.forEach((item) => {
        if (item.Name === "Amount") {
          paymentData.amount = item.Value;
        }

        if (item.Name === "MpesaReceiptNumber") {
          paymentData.mpesaReceipt =
            item.Value;
        }

        if (item.Name === "Balance") {
          paymentData.balance =
            item.Value;
        }

        if (item.Name === "TransactionDate") {
          paymentData.transactionDate =
            item.Value;
        }

        if (item.Name === "PhoneNumber") {
          paymentData.phone =
            item.Value;
        }
      });

      console.log("");
      console.log("PAYMENT SUCCESSFUL");
      console.log("M-PESA RECEIPT:", paymentData.mpesaReceipt);
      console.log("AMOUNT:", paymentData.amount);

    } else {
      console.log("");
      console.log("PAYMENT FAILED OR CANCELLED");
      console.log("ResultCode:", resultCode);
      console.log("ResultDesc:", resultDesc);
    }

    /*
      Update matching order.
    */
    if (orderIndex !== -1) {
      orders[orderIndex].merchantRequestId =
        merchantRequestId;

      orders[orderIndex].checkoutRequestId =
        checkoutRequestId;

      orders[orderIndex].resultCode =
        resultCode;

      orders[orderIndex].resultDesc =
        resultDesc;

      orders[orderIndex].payment =
        paymentData;

      orders[orderIndex].updatedAt =
        new Date().toISOString();

      orders[orderIndex].status =
        Number(resultCode) === 0
          ? "PAID"
          : "FAILED";

      saveOrders(orders);

      console.log(
        "Order updated:",
        orders[orderIndex].orderId
      );
    } else {
      /*
        Still store callbacks even if the order
        cannot be matched.
      */
      orders.push({
        orderId: `CALLBACK-${Date.now()}`,
        merchantRequestId,
        checkoutRequestId,
        resultCode,
        resultDesc,
        payment: paymentData,
        status:
          Number(resultCode) === 0
            ? "PAID"
            : "FAILED",
        createdAt:
          new Date().toISOString()
      });

      saveOrders(orders);

      console.log(
        "Callback received but matching order was not found."
      );
    }

    /*
      Daraja expects a successful HTTP response.
    */
    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });

  } catch (error) {
    console.error(
      "Callback processing error:",
      error
    );

    /*
      Always acknowledge the callback to Daraja.
    */
    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
});

/* =========================================================
   PAYMENT STATUS
   ========================================================= */

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  (req, res) => {
    try {
      const checkoutRequestId =
        req.params.checkoutRequestId;

      const orders = readOrders();

      const order = orders.find(
        (item) =>
          item.checkoutRequestId ===
          checkoutRequestId
      );

      if (!order) {
        return res.json({
          status: "PENDING",
          message:
            "Payment has not yet been confirmed."
        });
      }

      if (order.status === "PAID") {
        return res.json({
          status: "PAID",
          orderId: order.orderId,
          payment: order.payment || {},
          resultCode: order.resultCode,
          resultDesc: order.resultDesc
        });
      }

      if (order.status === "FAILED") {
        return res.json({
          status: "FAILED",
          orderId: order.orderId,
          resultCode: order.resultCode,
          resultDesc: order.resultDesc,
          message: order.resultDesc
        });
      }

      return res.json({
        status: "PENDING",
        orderId: order.orderId,
        message:
          "Waiting for M-PESA confirmation."
      });

    } catch (error) {
      console.error(
        "Payment status error:",
        error
      );

      return res.status(500).json({
        status: "ERROR",
        message:
          "Could not retrieve payment status."
      });
    }
  }
);

/* =========================================================
   VIEW SAVED ORDERS
   ========================================================= */

app.get("/api/orders", (req, res) => {
  try {
    return res.json(readOrders());
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Could not read orders."
    });
  }
});

/* =========================================================
   EXPRESS 5 FALLBACK
   ========================================================= */

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* =========================================================
   START SERVER
   ========================================================= */

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("=================================");
  console.log("ANANDA SERVER RUNNING");
  console.log("=================================");
  console.log("Port:", PORT);
  console.log("M-PESA Environment: SANDBOX");
  console.log("M-PESA Shortcode:", MPESA_SHORTCODE);
  console.log("Callback URL:", MPESA_CALLBACK_URL);
  console.log("=================================");
});
```
