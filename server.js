const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

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
// M-PESA SANDBOX URLS
// =====================================================

const MPESA_OAUTH_URL =
  "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

const MPESA_STK_URL =
  "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

const MPESA_STK_QUERY_URL =
  "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query";

// =====================================================
// FILE STORAGE
// =====================================================

const DATA_DIR = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

// =====================================================
// ENSURE DATA DIRECTORY EXISTS
// =====================================================

function ensureDataDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, "[]", "utf8");
  }
}

// =====================================================
// READ ORDERS
// =====================================================

function readOrders() {
  ensureDataDirectory();

  try {
    const content = fs.readFileSync(ORDERS_FILE, "utf8");

    if (!content.trim()) {
      return [];
    }

    const parsed = JSON.parse(content);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not read orders.json:", error.message);
    return [];
  }
}

// =====================================================
// WRITE ORDERS
// =====================================================

function writeOrders(orders) {
  ensureDataDirectory();

  fs.writeFileSync(
    ORDERS_FILE,
    JSON.stringify(orders, null, 2),
    "utf8"
  );
}

// =====================================================
// FIND PAYMENT BY CHECKOUT REQUEST ID
// =====================================================

function findPayment(checkoutRequestId) {
  if (!checkoutRequestId) {
    return null;
  }

  const orders = readOrders();

  return (
    orders.find(
      (order) =>
        order.checkoutRequestId === checkoutRequestId
    ) || null
  );
}

// =====================================================
// UPDATE PAYMENT
// =====================================================

function updatePayment(checkoutRequestId, updates) {
  if (!checkoutRequestId) {
    return null;
  }

  const orders = readOrders();

  const index = orders.findIndex(
    (order) =>
      order.checkoutRequestId === checkoutRequestId
  );

  if (index === -1) {
    return null;
  }

  orders[index] = {
    ...orders[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  writeOrders(orders);

  return orders[index];
}

// =====================================================
// ADD PAYMENT
// =====================================================

function addPayment(payment) {
  const orders = readOrders();

  // Prevent duplicate CheckoutRequestID records
  if (payment.checkoutRequestId) {
    const existingIndex = orders.findIndex(
      (order) =>
        order.checkoutRequestId ===
        payment.checkoutRequestId
    );

    if (existingIndex !== -1) {
      orders[existingIndex] = {
        ...orders[existingIndex],
        ...payment,
        updatedAt: new Date().toISOString()
      };

      writeOrders(orders);

      return orders[existingIndex];
    }
  }

  orders.push({
    ...payment,
    createdAt:
      payment.createdAt ||
      new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  writeOrders(orders);

  return orders[orders.length - 1];
}

// =====================================================
// ENVIRONMENT CONFIGURATION
// =====================================================

function checkConfiguration() {
  const missing = [];

  if (!MPESA_CONSUMER_KEY) {
    missing.push("MPESA_CONSUMER_KEY");
  }

  if (!MPESA_CONSUMER_SECRET) {
    missing.push("MPESA_CONSUMER_SECRET");
  }

  if (!MPESA_SHORTCODE) {
    missing.push("MPESA_SHORTCODE");
  }

  if (!MPESA_PASSKEY) {
    missing.push("MPESA_PASSKEY");
  }

  if (!MPESA_CALLBACK_URL) {
    missing.push("MPESA_CALLBACK_URL");
  }

  if (missing.length > 0) {
    console.error(
      "Missing environment variables:",
      missing.join(", ")
    );

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

  if (
    number.startsWith("7") ||
    number.startsWith("1")
  ) {
    number = "254" + number;
  }

  return number;
}

// =====================================================
// GET M-PESA ACCESS TOKEN
// =====================================================

async function getMpesaToken() {
  if (
    !MPESA_CONSUMER_KEY ||
    !MPESA_CONSUMER_SECRET
  ) {
    throw new Error(
      "M-PESA consumer key or consumer secret is missing."
    );
  }

  const auth = Buffer.from(
    `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    MPESA_OAUTH_URL,
    {
      headers: {
        Authorization: `Basic ${auth}`
      },
      timeout: 30000
    }
  );

  if (!response.data?.access_token) {
    throw new Error(
      "M-PESA access token was not returned."
    );
  }

  return response.data.access_token;
}

// =====================================================
// QUERY STK PUSH STATUS
// =====================================================

async function queryStkStatus(
  checkoutRequestId
) {
  if (!checkoutRequestId) {
    throw new Error(
      "CheckoutRequestID is required for STK status query."
    );
  }

  const token = await getMpesaToken();

  const timestamp = getTimestamp();

  const password = Buffer.from(
    `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
  ).toString("base64");

  const queryData = {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  };

  console.log(
    "================================="
  );
  console.log("M-PESA STK STATUS QUERY");
  console.log(
    "================================="
  );
  console.log(
    "CheckoutRequestID:",
    checkoutRequestId
  );

  try {
    const response = await axios.post(
      MPESA_STK_QUERY_URL,
      queryData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    console.log(
      "STK Query response:",
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    return response.data;
  } catch (error) {
    console.error(
      "STK Query error:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}

// =====================================================
// INTERPRET STK QUERY RESPONSE
// =====================================================

function interpretStkQueryResponse(data) {
  if (!data) {
    return {
      status: "UNKNOWN",
      message: "No response from M-PESA."
    };
  }

  const responseCode =
    data.ResponseCode !== undefined
      ? String(data.ResponseCode)
      : null;

  const resultCode =
    data.ResultCode !== undefined
      ? String(data.ResultCode)
      : null;

  const resultDesc =
    data.ResultDesc ||
    data.ResponseDescription ||
    "";

  // Query completed successfully
  if (
    responseCode === "0" &&
    resultCode === "0"
  ) {
    return {
      status: "PAID",
      message:
        resultDesc ||
        "Payment confirmed by M-PESA."
    };
  }

  // Some Daraja responses use ResponseCode 0
  // for a successful query while the final
  // transaction result may be represented
  // separately.
  if (
    responseCode === "0" &&
    !resultCode
  ) {
    return {
      status: "VERIFIED",
      message:
        resultDesc ||
        "M-PESA accepted the status query."
    };
  }

  // Explicit failure/cancellation
  if (
    resultCode &&
    resultCode !== "0"
  ) {
    return {
      status: "FAILED",
      resultCode,
      message:
        resultDesc ||
        "M-PESA reports that the payment was not successful."
    };
  }

  return {
    status: "PENDING",
    message:
      resultDesc ||
      "Payment is still being processed."
  };
}

// =====================================================
// VERIFY A PAYMENT
// =====================================================

async function verifyPayment(
  checkoutRequestId
) {
  const existing =
    findPayment(checkoutRequestId);

  if (!existing) {
    console.log(
      "Cannot verify unknown CheckoutRequestID:",
      checkoutRequestId
    );

    return null;
  }

  try {
    const result =
      await queryStkStatus(
        checkoutRequestId
      );

    const interpretation =
      interpretStkQueryResponse(result);

    console.log(
      "STK STATUS:",
      interpretation.status
    );

    // -------------------------------------------------
    // PAYMENT CONFIRMED
    // -------------------------------------------------

    if (
      interpretation.status ===
        "PAID" ||
      interpretation.status ===
        "VERIFIED"
    ) {
      const updated =
        updatePayment(
          checkoutRequestId,
          {
            status: "PAID",
            verificationStatus:
              "CONFIRMED",
            verificationResponse:
              result,
            verifiedAt:
              new Date().toISOString()
          }
        );

      console.log(
        "================================="
      );
      console.log(
        "PAYMENT VERIFIED AS PAID"
      );
      console.log(
        "CheckoutRequestID:",
        checkoutRequestId
      );
      console.log(
        "================================="
      );

      return updated;
    }

    // -------------------------------------------------
    // PAYMENT FAILED
    // -------------------------------------------------

    if (
      interpretation.status ===
      "FAILED"
    ) {
      const updated =
        updatePayment(
          checkoutRequestId,
          {
            status: "FAILED",
            verificationStatus:
              "CONFIRMED_FAILED",
            verificationResponse:
              result,
            verifiedAt:
              new Date().toISOString()
          }
        );

      console.log(
        "Payment verified as FAILED."
      );

      return updated;
    }

    // -------------------------------------------------
    // STILL PENDING
    // -------------------------------------------------

    const updated =
      updatePayment(
        checkoutRequestId,
        {
          status: "PENDING",
          verificationStatus:
            "STILL_PROCESSING",
          verificationResponse:
            result,
          lastCheckedAt:
            new Date().toISOString()
        }
      );

    return updated;
  } catch (error) {
    updatePayment(
      checkoutRequestId,
      {
        status: "PENDING_VERIFICATION",
        verificationStatus:
          "QUERY_ERROR",
        verificationError:
          error.response?.data ||
          error.message,
        lastCheckedAt:
          new Date().toISOString()
      }
    );

    return findPayment(
      checkoutRequestId
    );
  }
}

// =====================================================
// AUTOMATIC RETRY VERIFICATION
// =====================================================

function scheduleVerification(
  checkoutRequestId
) {
  if (!checkoutRequestId) {
    return;
  }

  // First check after 5 seconds
  setTimeout(async () => {
    console.log(
      "Running automatic M-PESA verification..."
    );

    await verifyPayment(
      checkoutRequestId
    );
  }, 5000);

  // Second check after 15 seconds
  setTimeout(async () => {
    const current =
      findPayment(checkoutRequestId);

    if (
      current &&
      current.status !== "PAID" &&
      current.status !== "FAILED"
    ) {
      console.log(
        "Running second automatic M-PESA verification..."
      );

      await verifyPayment(
        checkoutRequestId
      );
    }
  }, 15000);
}

// =====================================================
// STK PUSH
// =====================================================

app.post(
  "/api/mpesa/stkpush",
  async (req, res) => {
    try {
      if (!checkConfiguration()) {
        return res.status(500).json({
          success: false,
          message:
            "M-PESA environment variables are missing."
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
          message:
            "Phone number is required."
        });
      }

      if (
        amount === undefined ||
        amount === null ||
        amount === ""
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Amount is required."
        });
      }

      const phoneNumber =
        normalizePhone(phone);

      const totalAmount =
        Math.round(Number(amount));

      if (
        !/^2547\d{8}$/.test(
          phoneNumber
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid Kenyan Safaricom number."
        });
      }

      if (
        !Number.isFinite(
          totalAmount
        ) ||
        totalAmount < 1
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid payment amount."
        });
      }

      // ------------------------------------------------
      // GET ACCESS TOKEN
      // ------------------------------------------------

      const token =
        await getMpesaToken();

      // ------------------------------------------------
      // TIMESTAMP
      // ------------------------------------------------

      const timestamp =
        getTimestamp();

      // ------------------------------------------------
      // STK PASSWORD
      // ------------------------------------------------

      const password =
        Buffer.from(
          `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
        ).toString("base64");

      // ------------------------------------------------
      // STK DATA
      // ------------------------------------------------

      const stkData = {
        BusinessShortCode:
          MPESA_SHORTCODE,

        Password: password,

        Timestamp: timestamp,

        TransactionType:
          "CustomerPayBillOnline",

        Amount: totalAmount,

        PartyA: phoneNumber,

        PartyB: MPESA_SHORTCODE,

        PhoneNumber: phoneNumber,

        CallBackURL:
          MPESA_CALLBACK_URL,

        AccountReference:
          accountReference ||
          orderId ||
          "ANANDA",

        TransactionDesc:
          transactionDesc ||
          "Ananda Herbal Products"
      };

      console.log(
        "================================="
      );
      console.log(
        "SENDING M-PESA STK PUSH"
      );
      console.log(
        "================================="
      );

      console.log(
        "Shortcode:",
        MPESA_SHORTCODE
      );

      console.log(
        "Phone:",
        phoneNumber
      );

      console.log(
        "Amount:",
        totalAmount
      );

      console.log(
        "Timestamp:",
        timestamp
      );

      console.log(
        "Callback URL:",
        MPESA_CALLBACK_URL
      );

      // ------------------------------------------------
      // SEND STK PUSH
      // ------------------------------------------------

      const response =
        await axios.post(
          MPESA_STK_URL,
          stkData,
          {
            headers: {
              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json"
            },

            timeout: 30000
          }
        );

      console.log(
        "STK Push response:",
        JSON.stringify(
          response.data,
          null,
          2
        )
      );

      const checkoutRequestId =
        response.data
          ?.CheckoutRequestID ||
        null;

      const merchantRequestId =
        response.data
          ?.MerchantRequestID ||
        null;

      // ------------------------------------------------
      // SAVE PENDING PAYMENT
      // ------------------------------------------------

      if (checkoutRequestId) {
        addPayment({
          status: "PENDING",

          paymentMethod:
            "MPESA_STK",

          name:
            name || null,

          orderId:
            orderId || null,

          accountReference:
            accountReference ||
            orderId ||
            "ANANDA",

          transactionDesc:
            transactionDesc ||
            "Ananda Herbal Products",

          phone:
            phoneNumber,

          amount:
            totalAmount,

          checkoutRequestId,

          merchantRequestId,

          stkResponse:
            response.data,

          receivedAt:
            new Date().toISOString()
        });

        console.log(
          "Payment saved as PENDING."
        );

        console.log(
          "CheckoutRequestID:",
          checkoutRequestId
        );
      }

      return res.json({
        success: true,

        message:
          response.data
            ?.CustomerMessage ||
          "M-PESA payment request sent.",

        data: response.data,

        checkoutRequestId,

        merchantRequestId
      });
    } catch (error) {
      console.error(
        "================================="
      );

      console.error(
        "STK PUSH ERROR"
      );

      console.error(
        "================================="
      );

      console.error(
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        success: false,

        message:
          "Failed to initiate M-PESA payment",

        details:
          error.response?.data ||
          error.message
      });
    }
  }
);

// =====================================================
// M-PESA CALLBACK
// =====================================================

app.post(
  "/api/mpesa/callback",
  async (req, res) => {
    console.log(
      "================================="
    );

    console.log(
      "M-PESA CALLBACK RECEIVED"
    );

    console.log(
      "================================="
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    try {
      const callback =
        req.body?.Body?.stkCallback;

      if (!callback) {
        console.error(
          "Invalid M-PESA callback received."
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted"
        });
      }

      const checkoutRequestId =
        callback.CheckoutRequestID ||
        null;

      const merchantRequestId =
        callback.MerchantRequestID ||
        null;

      const resultCode =
        callback.ResultCode ??
        null;

      const resultDesc =
        callback.ResultDesc ||
        null;

      // ------------------------------------------------
      // FIND EXISTING PAYMENT
      // ------------------------------------------------

      let existing =
        findPayment(
          checkoutRequestId
        );

      // ------------------------------------------------
      // CREATE PAYMENT IF NOT FOUND
      // ------------------------------------------------

      if (!existing) {
        existing =
          addPayment({
            status: "PENDING",

            paymentMethod:
              "MPESA_STK",

            checkoutRequestId,

            merchantRequestId,

            resultCode,

            resultDesc,

            callback
          });
      }

      // ------------------------------------------------
      // SUCCESSFUL CALLBACK
      // ------------------------------------------------

      if (
        Number(resultCode) === 0
      ) {
        const items =
          callback
            .CallbackMetadata
            ?.Item || [];

        const metadata = {};

        items.forEach((item) => {
          if (item?.Name) {
            metadata[item.Name] =
              item.Value;
          }
        });

        const paymentUpdate = {
          status: "PAID",

          verificationStatus:
            "CALLBACK_CONFIRMED",

          resultCode: 0,

          resultDesc,

          callback,

          mpesaReceipt:
            metadata
              .MpesaReceiptNumber ||
            null,

          amount:
            metadata.Amount ||
            null,

          phone:
            metadata.PhoneNumber ||
            null,

          transactionDate:
            metadata.TransactionDate ||
            null,

          paidAt:
            new Date().toISOString()
        };

        const updated =
          updatePayment(
            checkoutRequestId,
            paymentUpdate
          );

        console.log(
          "================================="
        );

        console.log(
          "PAYMENT SUCCESSFUL"
        );

        console.log(
          "Receipt:",
          paymentUpdate.mpesaReceipt
        );

        console.log(
          "Amount:",
          paymentUpdate.amount
        );

        console.log(
          "Phone:",
          paymentUpdate.phone
        );

        console.log(
          "CheckoutRequestID:",
          checkoutRequestId
        );

        console.log(
          "================================="
        );
      }

      // ------------------------------------------------
      // RESULT CODE 1037
      // ------------------------------------------------

      else if (
        Number(resultCode) === 1037
      ) {
        updatePayment(
          checkoutRequestId,
          {
            status:
              "PENDING_VERIFICATION",

            verificationStatus:
              "CALLBACK_1037",

            resultCode,

            resultDesc,

            callback,

            lastCallbackAt:
              new Date().toISOString()
          }
        );

        console.log(
          "================================="
        );

        console.log(
          "M-PESA RETURNED 1037"
        );

        console.log(
          "DO NOT MARK PAYMENT AS FAILED YET."
        );

        console.log(
          "ResultDesc:",
          resultDesc
        );

        console.log(
          "CheckoutRequestID:",
          checkoutRequestId
        );

        console.log(
          "Starting automatic STK verification..."
        );

        console.log(
          "================================="
        );

        // Verify asynchronously
        scheduleVerification(
          checkoutRequestId
        );
      }

      // ------------------------------------------------
      // OTHER NON-ZERO RESULT
      // ------------------------------------------------

      else {
        updatePayment(
          checkoutRequestId,
          {
            status: "FAILED",

            verificationStatus:
              "CALLBACK_FAILED",

            resultCode,

            resultDesc,

            callback,

            failedAt:
              new Date().toISOString()
          }
        );

        console.log(
          "================================="
        );

        console.log(
          "PAYMENT FAILED / CANCELLED"
        );

        console.log(
          "ResultCode:",
          resultCode
        );

        console.log(
          "ResultDesc:",
          resultDesc
        );

        console.log(
          "================================="
        );
      }
    } catch (error) {
      console.error(
        "Callback processing error:",
        error.message
      );
    }

    // ------------------------------------------------
    // ALWAYS ACKNOWLEDGE CALLBACK
    // ------------------------------------------------

    return res.json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }
);

// =====================================================
// MANUAL STK STATUS QUERY
// =====================================================

app.get(
  "/api/mpesa/status/:checkoutRequestId",
  async (req, res) => {
    const checkoutRequestId =
      req.params.checkoutRequestId;

    if (!checkoutRequestId) {
      return res.status(400).json({
        success: false,
        message:
          "CheckoutRequestID is required."
      });
    }

    try {
      let payment =
        findPayment(
          checkoutRequestId
        );

      if (!payment) {
        return res.status(404).json({
          success: false,
          message:
            "Payment not found.",
          checkoutRequestId
        });
      }

      // If already final, don't need
      // to query M-PESA again.
      if (
        payment.status === "PAID" ||
        payment.status === "FAILED"
      ) {
        return res.json({
          success: true,

          status:
            payment.status,

          payment,

          source:
            "local-final-status"
        });
      }

      // Query M-PESA
      payment =
        await verifyPayment(
          checkoutRequestId
        );

      return res.json({
        success: true,

        status:
          payment?.status ||
          "PENDING",

        payment,

        source:
          "mpesa-stk-query"
      });
    } catch (error) {
      console.error(
        "Payment status endpoint error:",
        error.response?.data ||
          error.message
      );

      return res.status(500).json({
        success: false,

        status: "PENDING",

        message:
          "Could not verify payment status yet.",

        details:
          error.response?.data ||
          error.message
      });
    }
  }
);

// =====================================================
// GET PAYMENT STATUS WITHOUT QUERYING M-PESA
// =====================================================

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  (req, res) => {
    const checkoutRequestId =
      req.params.checkoutRequestId;

    const payment =
      findPayment(
        checkoutRequestId
      );

    if (!payment) {
      return res.status(404).json({
        success: false,

        message:
          "Payment not found.",

        checkoutRequestId
      });
    }

    return res.json({
      success: true,

      status:
        payment.status,

      payment
    });
  }
);

// =====================================================
// HEALTH CHECK
// =====================================================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      success: true,

      message:
        "Ananda server is running",

      mpesaConfigured:
        checkConfiguration(),

      environment:
        "SANDBOX",

      timestamp:
        new Date().toISOString()
    });
  }
);

// =====================================================
// WEBSITE FALLBACK
// =====================================================

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

// =====================================================
// START SERVER
// =====================================================

ensureDataDirectory();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================="
    );

    console.log(
      `Ananda server running on port ${PORT}`
    );

    console.log(
      "M-PESA environment: SANDBOX"
    );

    console.log(
      "M-PESA configured:",
      checkConfiguration()
    );

    console.log(
      "Callback URL:",
      MPESA_CALLBACK_URL ||
        "NOT SET"
    );

    console.log(
      "================================="
    );
  }
);
