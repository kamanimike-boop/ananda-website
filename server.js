const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

/* =========================================================
   M-PESA CONFIGURATION
========================================================= */

const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE;
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const MPESA_CALLBACK_URL = process.env.MPESA_CALLBACK_URL;

const MPESA_BASE_URL = "https://sandbox.safaricom.co.ke";

/* =========================================================
   ORDER STORAGE
========================================================= */

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

/* =========================================================
   HEALTH CHECK
========================================================= */

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

/* =========================================================
   PHONE NORMALIZATION
========================================================= */

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

/* =========================================================
   ACCESS TOKEN
========================================================= */

async function getAccessToken() {
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    throw new Error(
      "MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is missing"
    );
  }

  const credentials = Buffer.from(
    MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET
  ).toString("base64");

  const response = await axios.get(
    MPESA_BASE_URL +
      "/oauth/v1/generate?grant_type=client_credentials",
    {
      headers: {
        Authorization: "Basic " + credentials
      },
      timeout: 30000
    }
  );

  if (!response.data || !response.data.access_token) {
    throw new Error("M-PESA access token was not returned");
  }

  return response.data.access_token;
}

/* =========================================================
   STK PUSH
========================================================= */

app.post("/api/mpesa/stkpush", async (req, res) => {
  try {
    console.log("");
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
    console.log("Amount received:", amount);
    console.log("Order ID:", orderId);

    /* -----------------------------------------
       CHECK CONFIGURATION
    ----------------------------------------- */

    if (
      !MPESA_CONSUMER_KEY ||
      !MPESA_CONSUMER_SECRET ||
      !MPESA_SHORTCODE ||
      !MPESA_PASSKEY ||
      !MPESA_CALLBACK_URL
    ) {
      console.error("M-PESA environment variables incomplete");

      return res.status(500).json({
        success: false,
        error: "M-PESA configuration is incomplete"
      });
    }

    /* -----------------------------------------
       NORMALIZE PHONE
    ----------------------------------------- */

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        error:
          "Invalid Kenyan phone number. Use 07XXXXXXXX, 01XXXXXXXX or 254XXXXXXXXX."
      });
    }

    /* -----------------------------------------
       VALIDATE AMOUNT
    ----------------------------------------- */

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Invalid payment amount"
      });
    }

    const finalAmount = Math.round(numericAmount);

    /* -----------------------------------------
       GET ACCESS TOKEN
    ----------------------------------------- */

    console.log("Requesting M-PESA access token...");

    const accessToken = await getAccessToken();

    console.log("Access token received.");

    /* -----------------------------------------
       TIMESTAMP
    ----------------------------------------- */

    const timestamp = getKenyaTimestamp();

    console.log("Timestamp:", timestamp);

    /* -----------------------------------------
       STK PASSWORD

       IMPORTANT:
       Base64(
         BusinessShortCode +
         Passkey +
         Timestamp
       )

       DO NOT SHA256 HASH IT.
    ----------------------------------------- */

    const password = Buffer.from(
      MPESA_SHORTCODE +
      MPESA_PASSKEY +
      timestamp
    ).toString("base64");

    /* -----------------------------------------
       STK PAYLOAD
    ----------------------------------------- */

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,

      Password: password,

      Timestamp: timestamp,

      TransactionType: "CustomerPayBillOnline",

      Amount: finalAmount,

      PartyA: normalizedPhone,

      PartyB: MPESA_SHORTCODE,

      PhoneNumber: normalizedPhone,

      CallBackURL: MPESA_CALLBACK_URL,

      AccountReference: String(
        accountReference ||
        orderId ||
        "ANANDA"
      ).substring(0, 12),

      TransactionDesc: String(
        transactionDesc ||
        "ANANDA Herbal Products"
      ).substring(0, 20)
    };

    console.log("");
    console.log("STK REQUEST DETAILS");
    console.log("-----------------------------");
    console.log("Shortcode:", MPESA_SHORTCODE);
    console.log("Phone:", normalizedPhone);
    console.log("Amount:", finalAmount);
    console.log("TransactionType:", payload.TransactionType);
    console.log("Callback:", MPESA_CALLBACK_URL);
    console.log("AccountReference:", payload.AccountReference);
    console.log("-----------------------------");

    /* -----------------------------------------
       SEND STK PUSH
    ----------------------------------------- */

    const response = await axios.post(
      MPESA_BASE_URL +
        "/mpesa/stkpush/v1/processrequest",
      payload,
      {
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log("");
    console.log("STK PUSH RESPONSE");
    console.log("-----------------------------");
    console.log(
      JSON.stringify(response.data, null, 2)
    );
    console.log("-----------------------------");

    const checkoutRequestId =
      response.data.CheckoutRequestID;

    const merchantRequestId =
      response.data.MerchantRequestID;

    /* -----------------------------------------
       IF SAFARICOM DID NOT ACCEPT REQUEST
    ----------------------------------------- */

    if (
      response.data.ResponseCode &&
      String(response.data.ResponseCode) !== "0"
    ) {
      return res.status(400).json({
        success: false,
        error:
          response.data.ResponseDescription ||
          "M-PESA rejected the STK request",

        responseCode: response.data.ResponseCode
      });
    }

    /* -----------------------------------------
       SAVE PENDING ORDER
    ----------------------------------------- */

    const orders = readOrders();

    orders.push({
      orderId: orderId || null,

      merchantRequestId:
        merchantRequestId || null,

      checkoutRequestId:
        checkoutRequestId || null,

      name: name || "",

      phone: normalizedPhone,

      email: email || "",

      address: address || "",

      city: city || "",

      items: Array.isArray(items)
        ? items
        : [],

      amount: finalAmount,

      status: "PENDING",

      resultCode: null,

      resultDesc: null,

      mpesaReceiptNumber: null,

      transactionDate: null,

      paidPhone: null,

      paidAmount: null,

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    });

    writeOrders(orders);

    /* -----------------------------------------
       RETURN TO WEBSITE
    ----------------------------------------- */

    return res.json({
      success: true,

      message:
        response.data.CustomerMessage ||
        "STK Push sent successfully",

      customerMessage:
        response.data.CustomerMessage ||
        null,

      merchantRequestId,

      checkoutRequestId,

      responseCode:
        response.data.ResponseCode,

      responseDescription:
        response.data.ResponseDescription
    });

  } catch (error) {

    console.error("");
    console.error("=================================");
    console.error("STK PUSH ERROR");
    console.error("=================================");

    if (error.response) {

      console.error(
        "HTTP STATUS:",
        error.response.status
      );

      console.error(
        "M-PESA ERROR:",
        JSON.stringify(
          error.response.data,
          null,
          2
        )
      );

      return res.status(
        error.response.status || 500
      ).json({
        success: false,

        error:
          error.response.data?.errorMessage ||
          error.response.data?.ResponseDescription ||
          "M-PESA STK Push failed",

        details:
          error.response.data || null
      });
    }

    console.error(
      "ERROR MESSAGE:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error:
        error.message ||
        "STK Push failed"
    });
  }
});

/* =========================================================
   M-PESA CALLBACK
========================================================= */

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

    /* -----------------------------------------
       INVALID CALLBACK
    ----------------------------------------- */

    if (!callback) {

      console.log(
        "No stkCallback found."
      );

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
      Number(callback.ResultCode);

    const resultDesc =
      callback.ResultDesc || "";

    console.log(
      "MerchantRequestID:",
      merchantRequestId
    );

    console.log(
      "CheckoutRequestID:",
      checkoutRequestId
    );

    console.log(
      "ResultCode:",
      resultCode
    );

    console.log(
      "ResultDesc:",
      resultDesc
    );

    /* -----------------------------------------
       EXTRACT CALLBACK METADATA
    ----------------------------------------- */

    let receiptNumber = null;

    let transactionDate = null;

    let phoneNumber = null;

    let amount = null;

    const metadata =
      callback.CallbackMetadata?.Item;

    if (Array.isArray(metadata)) {

      for (const item of metadata) {

        if (
          item.Name ===
          "MpesaReceiptNumber"
        ) {
          receiptNumber =
            item.Value;
        }

        if (
          item.Name ===
          "TransactionDate"
        ) {
          transactionDate =
            item.Value;
        }

        if (
          item.Name ===
          "PhoneNumber"
        ) {
          phoneNumber =
            item.Value;
        }

        if (
          item.Name ===
          "Amount"
        ) {
          amount =
            item.Value;
        }
      }
    }

    /* -----------------------------------------
       FIND ORDER
    ----------------------------------------- */

    const orders = readOrders();

    const orderIndex =
      orders.findIndex(
        order =>
          order.checkoutRequestId ===
          checkoutRequestId
      );

    if (orderIndex === -1) {

      console.log("");
      console.log(
        "WARNING: No matching order."
      );

      console.log(
        "CheckoutRequestID:",
        checkoutRequestId
      );

      console.log(
        "MerchantRequestID:",
        merchantRequestId
      );

      /*
       * Still acknowledge Safaricom.
       */

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });
    }

    /* -----------------------------------------
       UPDATE ORDER
    ----------------------------------------- */

    orders[orderIndex].resultCode =
      resultCode;

    orders[orderIndex].resultDesc =
      resultDesc;

    orders[orderIndex].updatedAt =
      new Date().toISOString();

    /* -----------------------------------------
       SUCCESS
    ----------------------------------------- */

    if (resultCode === 0) {

      orders[orderIndex].status =
        "PAID";

      orders[orderIndex].mpesaReceiptNumber =
        receiptNumber;

      orders[orderIndex].transactionDate =
        transactionDate;

      orders[orderIndex].paidPhone =
        phoneNumber;

      orders[orderIndex].paidAmount =
        amount;

      console.log("");
      console.log("=================================");
      console.log("PAYMENT SUCCESSFUL");
      console.log("=================================");

      console.log(
        "Receipt:",
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

      /* ---------------------------------------
         FAILED / CANCELLED / TIMEOUT
      --------------------------------------- */

      orders[orderIndex].status =
        "FAILED";

      console.log("");
      console.log("=================================");
      console.log("PAYMENT FAILED / CANCELLED");
      console.log("=================================");

      console.log(
        "ResultCode:",
        resultCode
      );

      console.log(
        "ResultDesc:",
        resultDesc
      );

      /*
       * 1037 means the STK request timed out
       * because the user/device could not be
       * reached.
       *
       * This is NOT a successful payment.
       */

      if (resultCode === 1037) {

        console.log("");
        console.log(
          "M-PESA 1037 TIMEOUT"
        );

        console.log(
          "The STK request was accepted but"
        );

        console.log(
          "the M-PESA user/device could not"
        );

        console.log(
          "be reached before timeout."
        );
      }
    }

    writeOrders(orders);

  } catch (error) {

    console.error(
      "Callback processing error:",
      error
    );
  }

  /* -----------------------------------------
     ALWAYS ACKNOWLEDGE CALLBACK
  ----------------------------------------- */

  return res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
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

      const orders =
        readOrders();

      const order =
        orders.find(
          item =>
            item.checkoutRequestId ===
            checkoutRequestId
        );

      if (!order) {

        return res.status(404).json({
          success: false,

          status: "NOT_FOUND",

          message:
            "Payment record not found"
        });
      }

      return res.json({

        success: true,

        status:
          order.status,

        orderId:
          order.orderId,

        amount:
          order.amount,

        resultCode:
          order.resultCode,

        resultDesc:
          order.resultDesc,

        mpesaReceiptNumber:
          order.mpesaReceiptNumber ||
          null,

        transactionDate:
          order.transactionDate ||
          null
      });

    } catch (error) {

      console.error(
        "Payment status error:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Could not check payment status"
      });
    }
  }
);

/* =========================================================
   VIEW ORDERS
========================================================= */

app.get("/api/orders", (req, res) => {

  try {

    const orders =
      readOrders();

    return res.json({
      success: true,
      count: orders.length,
      orders
    });

  } catch (error) {

    console.error(
      "Orders error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Could not load orders"
    });
  }
});

/* =========================================================
   FRONTEND FALLBACK
========================================================= */

app.get("/{*splat}", (req, res) => {

  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});

/* =========================================================
   START SERVER
========================================================= */

const PORT =
  process.env.PORT || 10000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("=================================");
    console.log("ANANDA SERVER STARTED");
    console.log("=================================");

    console.log(
      "Port:",
      PORT
    );

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

    console.log(
      "Sandbox:",
      MPESA_BASE_URL
    );

    console.log("=================================");
  }
);
