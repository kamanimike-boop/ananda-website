const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

/* =========================================================
   CORS
========================================================= */

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* =========================================================
   BASIC EXPRESS SETUP
========================================================= */

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/*
  Prevent direct public access to orders.json.
*/
app.use("/data", (req, res) => {
  return res.status(404).json({
    success: false,
    error: "Not found"
  });
});

/*
  Serve the ANANDA website.
*/
app.use(express.static(__dirname));

/* =========================================================
   M-PESA CONFIGURATION
========================================================= */

/*
  IMPORTANT:

  You do NOT have live Safaricom credentials yet.

  Therefore:
      MPESA_ENV=sandbox

  is used by default.

  When you receive LIVE credentials from Safaricom,
  change Truehost environment variable to:

      MPESA_ENV=production

  The production Daraja URL is:
      https://api.safaricom.co.ke

  Sandbox URL is:
      https://sandbox.safaricom.co.ke
*/

const MPESA_ENV =
  String(process.env.MPESA_ENV || "sandbox").toLowerCase();

const MPESA_CONSUMER_KEY =
  process.env.MPESA_CONSUMER_KEY || "";

const MPESA_CONSUMER_SECRET =
  process.env.MPESA_CONSUMER_SECRET || "";

const MPESA_SHORTCODE =
  process.env.MPESA_SHORTCODE || "";

const MPESA_PASSKEY =
  process.env.MPESA_PASSKEY || "";

const MPESA_CALLBACK_URL =
  process.env.MPESA_CALLBACK_URL || "";

const MPESA_BASE_URL =
  process.env.MPESA_BASE_URL ||
  (
    MPESA_ENV === "production"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke"
  );

/* =========================================================
   WHATSAPP CLOUD API
========================================================= */

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_TOKEN || "";

const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const ADMIN_WHATSAPP_NUMBER =
  process.env.ADMIN_WHATSAPP_NUMBER || "";

const WHATSAPP_API_VERSION =
  process.env.WHATSAPP_API_VERSION || "23.0";

const WHATSAPP_BASE_URL =
  `https://graph.facebook.com/v${WHATSAPP_API_VERSION}`;

/* =========================================================
   ORDERS STORAGE
========================================================= */

const dataDir =
  path.join(__dirname, "data");

const ordersFile =
  path.join(dataDir, "orders.json");

/*
  Create data folder if it does not exist.
*/
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, {
    recursive: true
  });
}

/*
  Create orders.json if it does not exist.
*/
if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(
    ordersFile,
    "[]",
    "utf8"
  );
}

/* =========================================================
   READ ORDERS
========================================================= */

function readOrders() {
  try {
    const raw =
      fs.readFileSync(
        ordersFile,
        "utf8"
      );

    const orders =
      JSON.parse(raw);

    return Array.isArray(orders)
      ? orders
      : [];

  } catch (error) {
    console.error(
      "Could not read orders:",
      error.message
    );

    return [];
  }
}

/* =========================================================
   WRITE ORDERS
========================================================= */

function writeOrders(orders) {
  try {
    fs.writeFileSync(
      ordersFile,
      JSON.stringify(
        orders,
        null,
        2
      ),
      "utf8"
    );

  } catch (error) {
    console.error(
      "Could not write orders:",
      error.message
    );

    throw error;
  }
}

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "OK",

      message:
        "ANANDA server is running",

      mpesaConfigured:
        Boolean(
          MPESA_CONSUMER_KEY &&
          MPESA_CONSUMER_SECRET &&
          MPESA_SHORTCODE &&
          MPESA_PASSKEY &&
          MPESA_CALLBACK_URL
        ),

      mpesaEnvironment:
        MPESA_ENV,

      mpesaBaseUrl:
        MPESA_BASE_URL,

      mpesaCallback:
        MPESA_CALLBACK_URL || null,

      whatsappConfigured:
        Boolean(
          WHATSAPP_TOKEN &&
          WHATSAPP_PHONE_NUMBER_ID &&
          ADMIN_WHATSAPP_NUMBER
        )
    });
  }
);

/* =========================================================
   M-PESA CONFIGURATION CHECK
========================================================= */

function mpesaIsConfigured() {
  return Boolean(
    MPESA_CONSUMER_KEY &&
    MPESA_CONSUMER_SECRET &&
    MPESA_SHORTCODE &&
    MPESA_PASSKEY &&
    MPESA_CALLBACK_URL
  );
}

/* =========================================================
   KENYA TIMESTAMP
========================================================= */

function getKenyaTimestamp() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Africa/Nairobi",

        year:
          "numeric",

        month:
          "2-digit",

        day:
          "2-digit",

        hour:
          "2-digit",

        minute:
          "2-digit",

        second:
          "2-digit",

        hourCycle:
          "h23"
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] =
        part.value;
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
   PHONE NUMBER NORMALIZATION
========================================================= */

function normalizePhone(phone) {
  if (!phone) {
    return null;
  }

  let value =
    String(phone).trim();

  value =
    value.replace(
      /\s+/g,
      ""
    );

  value =
    value.replace(
      /-/g,
      ""
    );

  value =
    value.replace(
      /^\+/,
      ""
    );

  /*
    0712345678
    0112345678
  */
  if (
    value.startsWith("07") ||
    value.startsWith("01")
  ) {
    value =
      "254" +
      value.substring(1);
  }

  /*
    712345678
    112345678
  */
  else if (
    value.startsWith("7") ||
    value.startsWith("1")
  ) {
    value =
      "254" +
      value;
  }

  /*
    Must become:

    2547XXXXXXXX
    or
    2541XXXXXXXX
  */
  if (
    !/^254[17]\d{8}$/.test(
      value
    )
  ) {
    return null;
  }

  return value;
}

/* =========================================================
   WHATSAPP NUMBER NORMALIZATION
========================================================= */

function normalizeWhatsAppNumber(phone) {
  if (!phone) {
    return null;
  }

  let value =
    String(phone).trim();

  value =
    value.replace(
      /\s+/g,
      ""
    );

  value =
    value.replace(
      /-/g,
      ""
    );

  value =
    value.replace(
      /^\+/,
      ""
    );

  if (
    value.startsWith("0")
  ) {
    value =
      "254" +
      value.substring(1);
  }

  else if (
    value.startsWith("7") ||
    value.startsWith("1")
  ) {
    value =
      "254" +
      value;
  }

  return value;
}

/* =========================================================
   GET M-PESA ACCESS TOKEN
========================================================= */

async function getAccessToken() {
  if (
    !MPESA_CONSUMER_KEY ||
    !MPESA_CONSUMER_SECRET
  ) {
    throw new Error(
      "MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET is missing"
    );
  }

  /*
    Daraja OAuth:

    Base64(
      ConsumerKey:ConsumerSecret
    )
  */

  const credentials =
    Buffer.from(
      `${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`
    ).toString(
      "base64"
    );

  const response =
    await axios.get(
      `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization:
            `Basic ${credentials}`
        },

        timeout: 30000
      }
    );

  if (
    !response.data ||
    !response.data.access_token
  ) {
    throw new Error(
      "M-PESA access token was not returned"
    );
  }

  return response.data.access_token;
}

/* =========================================================
   ACCOUNT REFERENCE
========================================================= */

function createAccountReference(orderId) {
  const reference =
    String(
      orderId ||
      "ANANDA"
    );

  /*
    Keep AccountReference short.
  */
  return reference.substring(
    0,
    12
  );
}

/* =========================================================
   SEND WHATSAPP MESSAGE
========================================================= */

async function sendWhatsAppMessage(
  to,
  messageBody
) {
  if (
    !WHATSAPP_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID ||
    !to
  ) {
    console.log(
      "WhatsApp notification skipped: configuration missing."
    );

    return;
  }

  const recipient =
    normalizeWhatsAppNumber(to);

  if (!recipient) {
    console.error(
      "Invalid WhatsApp recipient number."
    );

    return;
  }

  try {
    const url =
      `${WHATSAPP_BASE_URL}/` +
      `${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const payload = {
      messaging_product:
        "whatsapp",

      to:
        recipient,

      type:
        "text",

      text: {
        preview_url:
          false,

        body:
          messageBody
      }
    };

    const response =
      await axios.post(
        url,
        payload,
        {
          headers: {
            Authorization:
              `Bearer ${WHATSAPP_TOKEN}`,

            "Content-Type":
              "application/json"
          },

          timeout:
            15000
        }
      );

    console.log(
      "WhatsApp notification sent:"
    );

    console.log(
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

  } catch (error) {
    console.error(
      "WhatsApp notification failed:"
    );

    console.error(
      error.response?.data ||
      error.message
    );
  }
}

/* =========================================================
   BUILD WHATSAPP ORDER MESSAGE
========================================================= */

function buildWhatsAppOrderMessage(
  order
) {
  const items =
    Array.isArray(order.items)
      ? order.items
      : [];

  let itemsList =
    "No items listed";

  if (items.length > 0) {
    itemsList =
      items
        .map(
          (item) => {
            const name =
              item?.name ||
              "Product";

            const quantity =
              item?.quantity ||
              1;

            return (
              `- ${name} x${quantity}`
            );
          }
        )
        .join("\n");
  }

  return (
    `NEW ANANDA M-PESA ORDER PAID\n\n` +
    `Order ID: ${order.orderId}\n` +
    `Amount: KES ${order.paidAmount ?? order.amount}\n` +
    `M-PESA Receipt: ${order.mpesaReceiptNumber || ""}\n` +
    `Customer: ${order.name || ""}\n` +
    `Phone: ${order.paidPhone || order.phone || ""}\n` +
    `Address: ${order.address || ""}, ${order.city || ""}\n\n` +
    `Items:\n${itemsList}`
  );
}

/* =========================================================
   M-PESA STK PUSH
========================================================= */

app.post(
  "/api/mpesa/stkpush",
  async (req, res) => {

    try {
      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "ANANDA M-PESA STK PUSH"
      );
      console.log(
        "Environment:",
        MPESA_ENV
      );
      console.log(
        "Base URL:",
        MPESA_BASE_URL
      );
      console.log(
        "================================="
      );

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
      } = req.body || {};

      /*
        Configuration check
      */
      if (!mpesaIsConfigured()) {
        return res
          .status(500)
          .json({
            success:
              false,

            error:
              "M-PESA configuration is incomplete. Check your Truehost environment variables."
          });
      }

      /*
        Order ID
      */
      if (
        !orderId ||
        !String(orderId).trim()
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Order ID is required"
          });
      }

      const cleanOrderId =
        String(orderId).trim();

      /*
        Phone number
      */
      const normalizedPhone =
        normalizePhone(phone);

      if (!normalizedPhone) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Invalid Kenyan phone number. Use 07XXXXXXXX or 01XXXXXXXX."
          });
      }

      /*
        Amount
      */
      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount <= 0
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Invalid payment amount"
          });
      }

      const finalAmount =
        Math.round(
          numericAmount
        );

      if (finalAmount <= 0) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Payment amount must be greater than zero"
          });
      }

      console.log(
        "Customer:",
        name || ""
      );

      console.log(
        "Phone:",
        normalizedPhone
      );

      console.log(
        "Amount:",
        finalAmount
      );

      console.log(
        "Order ID:",
        cleanOrderId
      );

      /*
        Get access token
      */
      console.log(
        "Requesting M-PESA access token..."
      );

      const accessToken =
        await getAccessToken();

      console.log(
        "M-PESA access token received."
      );

      /*
        Timestamp
      */
      const timestamp =
        getKenyaTimestamp();

      console.log(
        "Timestamp:",
        timestamp
      );

      /*
        Password:

        Base64(
          Shortcode +
          Passkey +
          Timestamp
        )
      */
      const password =
        Buffer.from(
          `${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`
        ).toString(
          "base64"
        );

      /*
        Account reference
      */
      const reference =
        createAccountReference(
          accountReference ||
          cleanOrderId
        );

      /*
        Transaction description
      */
      const description =
        String(
          transactionDesc ||
          "ANANDA Herbal Products"
        ).substring(
          0,
          20
        );

      /*
        STK payload
      */
      const payload = {
        BusinessShortCode:
          MPESA_SHORTCODE,

        Password:
          password,

        Timestamp:
          timestamp,

        TransactionType:
          "CustomerPayBillOnline",

        Amount:
          finalAmount,

        PartyA:
          normalizedPhone,

        PartyB:
          MPESA_SHORTCODE,

        PhoneNumber:
          normalizedPhone,

        CallBackURL:
          MPESA_CALLBACK_URL,

        AccountReference:
          reference,

        TransactionDesc:
          description
      };

      console.log("");
      console.log(
        "STK REQUEST"
      );
      console.log(
        "Shortcode:",
        MPESA_SHORTCODE
      );
      console.log(
        "Phone:",
        normalizedPhone
      );
      console.log(
        "Amount:",
        finalAmount
      );
      console.log(
        "Callback:",
        MPESA_CALLBACK_URL
      );
      console.log(
        "AccountReference:",
        reference
      );
      console.log(
        "TransactionDesc:",
        description
      );

      /*
        Send STK Push
      */
      const response =
        await axios.post(
          `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
          payload,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json"
            },

            timeout:
              30000
          }
        );

      console.log("");
      console.log(
        "STK PUSH RESPONSE"
      );

      console.log(
        JSON.stringify(
          response.data,
          null,
          2
        )
      );

      /*
        Response IDs
      */
      const checkoutRequestId =
        response.data?.CheckoutRequestID ||
        null;

      const merchantRequestId =
        response.data?.MerchantRequestID ||
        null;

      const responseCode =
        response.data?.ResponseCode;

      /*
        Verify Daraja accepted request
      */
      if (
        String(responseCode) !== "0" ||
        !checkoutRequestId
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            error:
              response.data?.ResponseDescription ||
              response.data?.errorMessage ||
              "M-PESA STK Push was not accepted",

            responseCode:
              responseCode ||
              null
          });
      }

      /*
        Save pending order
      */
      const orders =
        readOrders();

      const now =
        new Date().toISOString();

      /*
        Prevent duplicate order records.
      */
      const existingIndex =
        orders.findIndex(
          (order) =>
            order.orderId ===
            cleanOrderId
        );

      const orderRecord = {
        orderId:
          cleanOrderId,

        merchantRequestId:
          merchantRequestId,

        checkoutRequestId:
          checkoutRequestId,

        name:
          name || "",

        phone:
          normalizedPhone,

        email:
          email || "",

        address:
          address || "",

        city:
          city || "",

        items:
          Array.isArray(items)
            ? items
            : [],

        amount:
          finalAmount,

        accountReference:
          reference,

        transactionDesc:
          description,

        status:
          "PENDING",

        resultCode:
          null,

        resultDesc:
          null,

        mpesaReceiptNumber:
          null,

        transactionDate:
          null,

        paidPhone:
          null,

        paidAmount:
          null,

        createdAt:
          existingIndex >= 0 &&
          orders[existingIndex].createdAt
            ? orders[existingIndex].createdAt
            : now,

        updatedAt:
          now
      };

      if (existingIndex >= 0) {
        orders[existingIndex] = {
          ...orders[existingIndex],
          ...orderRecord
        };

      } else {
        orders.push(
          orderRecord
        );
      }

      writeOrders(
        orders
      );

      console.log(
        "PENDING ORDER SAVED:",
        cleanOrderId
      );

      /*
        Return to website
      */
      return res.json({
        success:
          true,

        message:
          response.data?.CustomerMessage ||
          "STK Push sent successfully",

        customerMessage:
          response.data?.CustomerMessage ||
          "Check your phone and enter your M-PESA PIN.",

        orderId:
          cleanOrderId,

        merchantRequestId:
          merchantRequestId,

        checkoutRequestId:
          checkoutRequestId,

        responseCode:
          responseCode,

        responseDescription:
          response.data?.ResponseDescription ||
          ""
      });

    } catch (error) {

      console.error("");
      console.error(
        "================================="
      );
      console.error(
        "M-PESA STK PUSH ERROR"
      );
      console.error(
        "================================="
      );

      if (error.response) {

        console.error(
          "HTTP STATUS:",
          error.response.status
        );

        console.error(
          "M-PESA RESPONSE:",
          JSON.stringify(
            error.response.data,
            null,
            2
          )
        );

        return res
          .status(
            error.response.status ||
            500
          )
          .json({
            success:
              false,

            error:
              error.response.data?.errorMessage ||
              error.response.data?.ResponseDescription ||
              "M-PESA STK Push failed",

            details:
              error.response.data ||
              null
          });
      }

      console.error(
        "Error:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "M-PESA STK Push failed"
        });
    }
  }
);

/* =========================================================
   M-PESA CALLBACK HANDLER
========================================================= */

async function handleMpesaCallback(
  req,
  res
) {
  console.log("");
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

    /*
      Invalid callback
    */
    if (!callback) {
      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }

    const merchantRequestId =
      callback.MerchantRequestID ||
      null;

    const checkoutRequestId =
      callback.CheckoutRequestID ||
      null;

    const resultCode =
      Number(
        callback.ResultCode
      );

    const resultDesc =
      callback.ResultDesc ||
      "";

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

    /*
      Callback metadata
    */
    let receiptNumber =
      null;

    let transactionDate =
      null;

    let phoneNumber =
      null;

    let amount =
      null;

    const metadata =
      callback
        .CallbackMetadata
        ?.Item;

    if (
      Array.isArray(metadata)
    ) {
      for (
        const item of metadata
      ) {

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

    /*
      Find saved order.
    */
    const orders =
      readOrders();

    const orderIndex =
      orders.findIndex(
        (order) =>
          order.checkoutRequestId ===
          checkoutRequestId
      );

    /*
      No matching order.
    */
    if (orderIndex < 0) {

      console.log(
        "WARNING: NO MATCHING ORDER"
      );

      /*
        Always acknowledge Safaricom.
      */
      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }

    const order =
      orders[orderIndex];

    /*
      Save callback information.
    */
    order.resultCode =
      resultCode;

    order.resultDesc =
      resultDesc;

    order.updatedAt =
      new Date().toISOString();

    /*
      PAYMENT SUCCESS
    */
    if (resultCode === 0) {

      order.status =
        "PAID";

      order.mpesaReceiptNumber =
        receiptNumber;

      order.transactionDate =
        transactionDate;

      order.paidPhone =
        phoneNumber;

      order.paidAmount =
        amount;

      console.log("");
      console.log(
        "================================="
      );
      console.log(
        "PAYMENT SUCCESSFUL"
      );
      console.log(
        "================================="
      );

      console.log(
        "Order ID:",
        order.orderId
      );

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

      /*
        SAVE PAID ORDER FIRST.
      */
      writeOrders(
        orders
      );

      /*
        WhatsApp notification
      */
      const message =
        buildWhatsAppOrderMessage(
          order
        );

      if (
        ADMIN_WHATSAPP_NUMBER
      ) {

        /*
          Do not delay Safaricom response
          while waiting for WhatsApp.
        */
        sendWhatsAppMessage(
          ADMIN_WHATSAPP_NUMBER,
          message
        ).catch(
          (error) => {
            console.error(
              "WhatsApp background error:",
              error.message
            );
          }
        );

      } else {

        console.log(
          "ADMIN_WHATSAPP_NUMBER is not configured."
        );
      }

    }

    /*
      PAYMENT FAILED / CANCELLED
    */
    else {

      order.status =
        "FAILED";

      writeOrders(
        orders
      );

      console.log("");
      console.log(
        "PAYMENT FAILED / CANCELLED"
      );

      console.log(
        "Order ID:",
        order.orderId
      );

      console.log(
        "ResultCode:",
        resultCode
      );

      console.log(
        "ResultDesc:",
        resultDesc
      );
    }

  } catch (error) {

    console.error(
      "Callback processing error:",
      error.message
    );
  }

  /*
    Always acknowledge callback.
  */
  return res.json({
    ResultCode:
      0,

    ResultDesc:
      "Accepted"
  });
}

/* =========================================================
   NEW PRODUCTION CALLBACK
========================================================= */

app.post(
  "/api/payment/callback",
  handleMpesaCallback
);

/* =========================================================
   OLD CALLBACK
   Kept so existing sandbox configuration continues working.
========================================================= */

app.post(
  "/api/mpesa/callback",
  handleMpesaCallback
);

/* =========================================================
   CHECK PAYMENT STATUS
========================================================= */

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  (req, res) => {

    try {
      const checkoutRequestId =
        req.params.checkoutRequestId;

      if (!checkoutRequestId) {
        return res
          .status(400)
          .json({
            success:
              false,

            status:
              "INVALID",

            message:
              "CheckoutRequestID is required"
          });
      }

      const orders =
        readOrders();

      const order =
        orders.find(
          (item) =>
            item.checkoutRequestId ===
            checkoutRequestId
        );

      if (!order) {
        return res
          .status(404)
          .json({
            success:
              false,

            status:
              "NOT_FOUND",

            message:
              "Payment record not found",

            checkoutRequestId:
              checkoutRequestId
          });
      }

      return res.json({

        success:
          true,

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
          null,

        paidPhone:
          order.paidPhone ||
          null,

        paidAmount:
          order.paidAmount ||
          null,

        createdAt:
          order.createdAt,

        updatedAt:
          order.updatedAt
      });

    } catch (error) {

      console.error(
        "Payment status error:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Could not check payment status"
        });
    }
  }
);

/* =========================================================
   GET ONE ORDER
========================================================= */

app.get(
  "/api/orders/:orderId",
  (req, res) => {

    try {
      const orderId =
        req.params.orderId;

      const orders =
        readOrders();

      const order =
        orders.find(
          (item) =>
            item.orderId ===
            orderId
        );

      if (!order) {
        return res
          .status(404)
          .json({
            success:
              false,

            status:
              "NOT_FOUND",

            message:
              "Order not found",

            orderId:
              orderId
          });
      }

      return res.json({

        success:
          true,

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
          null,

        paidPhone:
          order.paidPhone ||
          null,

        paidAmount:
          order.paidAmount ||
          null,

        checkoutRequestId:
          order.checkoutRequestId ||
          null,

        merchantRequestId:
          order.merchantRequestId ||
          null,

        createdAt:
          order.createdAt,

        updatedAt:
          order.updatedAt
      });

    } catch (error) {

      console.error(
        "Order lookup error:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Could not load order"
        });
    }
  }
);

/* =========================================================
   GET ALL ORDERS
========================================================= */

app.get(
  "/api/orders",
  (req, res) => {

    try {
      const orders =
        readOrders();

      return res.json({

        success:
          true,

        count:
          orders.length,

        orders:
          orders
      });

    } catch (error) {

      console.error(
        "Orders error:",
        error.message
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Could not load orders"
        });
    }
  }
);

/* =========================================================
   WEBSITE FALLBACK
========================================================= */

/*
  This is deliberately registered AFTER
  the API routes, so /api/... endpoints
  are not swallowed by index.html.
*/
app.use(
  (req, res, next) => {

    /*
      Do not send index.html for unknown API URLs.
    */
    if (
      req.path.startsWith("/api/")
    ) {
      return res
        .status(404)
        .json({
          success:
            false,

          error:
            "API endpoint not found"
        });
    }

    /*
      Website fallback.
    */
    return res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

const PORT =
  process.env.PORT ||
  10000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log("");
    console.log(
      "================================="
    );

    console.log(
      "ANANDA SERVER STARTED"
    );

    console.log(
      "================================="
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "M-PESA configured:",
      mpesaIsConfigured()
    );

    console.log(
      "M-PESA environment:",
      MPESA_ENV
    );

    console.log(
      "M-PESA base URL:",
      MPESA_BASE_URL
    );

    console.log(
      "M-PESA callback:",
      MPESA_CALLBACK_URL ||
      "(NOT SET)"
    );

    console.log(
      "WhatsApp configured:",
      Boolean(
        WHATSAPP_TOKEN &&
        WHATSAPP_PHONE_NUMBER_ID &&
        ADMIN_WHATSAPP_NUMBER
      )
    );

    console.log(
      "WhatsApp API:",
      WHATSAPP_BASE_URL
    );

    console.log(
      "================================="
    );
  }
);
