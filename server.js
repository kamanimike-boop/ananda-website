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
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));


/* =========================================================
   M-PESA SANDBOX CONFIGURATION
========================================================= */

const MPESA_CONSUMER_KEY =
  process.env.MPESA_CONSUMER_KEY;

const MPESA_CONSUMER_SECRET =
  process.env.MPESA_CONSUMER_SECRET;

const MPESA_SHORTCODE =
  process.env.MPESA_SHORTCODE;

const MPESA_PASSKEY =
  process.env.MPESA_PASSKEY;

const MPESA_CALLBACK_URL =
  process.env.MPESA_CALLBACK_URL ||
  "https://www.anandagreenherbary.co.ke/api/mpesa/callback";

/*
 * IMPORTANT:
 * We are intentionally using SANDBOX.
 */
const MPESA_BASE_URL =
  "https://sandbox.safaricom.co.ke";


/* =========================================================
   WHATSAPP CONFIGURATION
========================================================= */

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

/*
 * Default recipient requested:
 * 0723436496
 */
const ADMIN_WHATSAPP_NUMBER =
  process.env.ADMIN_WHATSAPP_NUMBER ||
  "0723436496";

const WHATSAPP_TEMPLATE_NAME =
  process.env.WHATSAPP_TEMPLATE_NAME ||
  "order_notification";

const WHATSAPP_TEMPLATE_LANGUAGE =
  process.env.WHATSAPP_TEMPLATE_LANGUAGE ||
  "en_US";

const WHATSAPP_BASE_URL =
  "https://graph.facebook.com/v21.0";


/* =========================================================
   ORDERS STORAGE
========================================================= */

const dataDir =
  path.join(__dirname, "data");

const ordersFile =
  path.join(dataDir, "orders.json");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, {
    recursive: true
  });
}

if (!fs.existsSync(ordersFile)) {
  fs.writeFileSync(
    ordersFile,
    "[]"
  );
}


/* =========================================================
   ORDER HELPERS
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
      error
    );

    return [];
  }
}


function writeOrders(orders) {

  fs.writeFileSync(
    ordersFile,
    JSON.stringify(
      orders,
      null,
      2
    )
  );
}


/* =========================================================
   PHONE NORMALIZATION
========================================================= */

function normalizePhone(phone) {

  if (!phone) {
    return null;
  }

  let value =
    String(phone)
      .trim()
      .replace(/\s+/g, "")
      .replace(/-/g, "")
      .replace(/^\+/, "");

  /*
   * 0723436496
   * ->
   * 254723436496
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
   * 723436496
   * ->
   * 254723436496
   */

  else if (
    value.startsWith("7") ||
    value.startsWith("1")
  ) {

    value =
      "254" +
      value;
  }

  if (
    !/^254[17]\d{8}$/.test(value)
  ) {

    return null;
  }

  return value;
}


/* =========================================================
   KENYA TIMESTAMP
========================================================= */

function getKenyaTimestamp() {

  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(
      new Date()
    );

  const values = {};

  for (const part of parts) {

    if (
      part.type !== "literal"
    ) {

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
   M-PESA ACCESS TOKEN
========================================================= */

async function getAccessToken() {

  if (
    !MPESA_CONSUMER_KEY ||
    !MPESA_CONSUMER_SECRET
  ) {

    throw new Error(
      "M-PESA Consumer Key or Consumer Secret is missing."
    );
  }

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
    !response.data?.access_token
  ) {

    throw new Error(
      "M-PESA access token was not returned."
    );
  }

  return response.data.access_token;
}


/* =========================================================
   ACCOUNT REFERENCE
========================================================= */

function createAccountReference(
  orderId
) {

  return String(
    orderId || "ANANDA"
  ).substring(
    0,
    12
  );
}


/* =========================================================
   WHATSAPP ORDER NOTIFICATION
========================================================= */

async function sendWhatsAppOrderNotification(
  order,
  amount,
  receiptNumber
) {

  if (
    !WHATSAPP_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {

    console.error(
      "❌ WhatsApp credentials missing."
    );

    return {
      success: false,
      error:
        "WhatsApp credentials missing"
    };
  }

  const recipient =
    normalizePhone(
      ADMIN_WHATSAPP_NUMBER
    );

  if (!recipient) {

    console.error(
      "❌ Invalid WhatsApp recipient:",
      ADMIN_WHATSAPP_NUMBER
    );

    return {
      success: false,
      error:
        "Invalid WhatsApp recipient"
    };
  }

  let itemsList =
    "No items";

  if (
    Array.isArray(order.items) &&
    order.items.length
  ) {

    itemsList =
      order.items
        .map(
          item =>
            `${item.name || "Item"} x${item.quantity || 1}`
        )
        .join(", ");
  }

  const url =
    `${WHATSAPP_BASE_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  /*
   * IMPORTANT:
   *
   * The Meta template must be approved
   * and contain FIVE body variables.
   *
   * {{1}} Order ID
   * {{2}} Amount
   * {{3}} Customer
   * {{4}} Items
   * {{5}} M-PESA Receipt
   */

  const payload = {

    messaging_product:
      "whatsapp",

    to:
      recipient,

    type:
      "template",

    template: {

      name:
        WHATSAPP_TEMPLATE_NAME,

      language: {
        code:
          WHATSAPP_TEMPLATE_LANGUAGE
      },

      components: [

        {
          type:
            "body",

          parameters: [

            {
              type:
                "text",

              text:
                String(
                  order.orderId || "-"
                )
            },

            {
              type:
                "text",

              text:
                `KES ${amount || "-"}`
            },

            {
              type:
                "text",

              text:
                String(
                  order.name || "-"
                )
            },

            {
              type:
                "text",

              text:
                itemsList
            },

            {
              type:
                "text",

              text:
                String(
                  receiptNumber || "-"
                )
            }

          ]
        }

      ]
    }
  };

  console.log(
    "📱 Sending WhatsApp order notification..."
  );

  console.log(
    "📱 WhatsApp recipient:",
    recipient
  );

  console.log(
    "📱 WhatsApp template:",
    WHATSAPP_TEMPLATE_NAME
  );

  try {

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
      "✅ WhatsApp notification accepted:",
      JSON.stringify(
        response.data,
        null,
        2
      )
    );

    return {
      success: true,
      data:
        response.data
    };

  } catch (error) {

    const details =
      error.response?.data ||
      {
        message:
          error.message
      };

    console.error(
      "❌ WHATSAPP ERROR:"
    );

    console.error(
      JSON.stringify(
        details,
        null,
        2
      )
    );

    return {
      success: false,
      error:
        details?.error?.message ||
        details?.message ||
        error.message
    };
  }
}


/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      status:
        "OK",

      sandbox:
        true,

      mpesaBaseUrl:
        MPESA_BASE_URL,

      mpesaConfigured:
        Boolean(
          MPESA_CONSUMER_KEY &&
          MPESA_CONSUMER_SECRET &&
          MPESA_SHORTCODE &&
          MPESA_PASSKEY &&
          MPESA_CALLBACK_URL
        ),

      whatsappConfigured:
        Boolean(
          WHATSAPP_TOKEN &&
          WHATSAPP_PHONE_NUMBER_ID &&
          ADMIN_WHATSAPP_NUMBER
        ),

      whatsappNumber:
        normalizePhone(
          ADMIN_WHATSAPP_NUMBER
        ),

      callbackUrl:
        MPESA_CALLBACK_URL

    });
  }
);


/* =========================================================
   TEST WHATSAPP
========================================================= */

app.post(
  "/api/whatsapp/test",
  async (req, res) => {

    const testOrder = {

      orderId:
        req.body?.orderId ||
        "TEST-ORDER",

      name:
        req.body?.name ||
        "WhatsApp Test",

      items:
        Array.isArray(
          req.body?.items
        )
          ? req.body.items
          : [
              {
                name:
                  "Test Item",
                quantity:
                  1
              }
            ]
    };

    const result =
      await sendWhatsAppOrderNotification(
        testOrder,
        req.body?.amount || 10,
        req.body?.receipt ||
          "TEST-RECEIPT"
      );

    if (!result.success) {

      return res.status(
        500
      ).json(result);
    }

    return res.json(result);
  }
);


/* =========================================================
   M-PESA STK PUSH
========================================================= */

app.post(
  "/api/mpesa/stkpush",
  async (req, res) => {

    try {

      console.log("");
      console.log(
        "======================================"
      );
      console.log(
        "M-PESA SANDBOX STK PUSH"
      );
      console.log(
        "======================================"
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
      } = req.body;

      console.log(
        "Customer:",
        name
      );

      console.log(
        "Phone:",
        phone
      );

      console.log(
        "Amount:",
        amount
      );

      console.log(
        "Order ID:",
        orderId
      );


      /* -----------------------------------------
         CONFIGURATION
      ----------------------------------------- */

      if (
        !MPESA_CONSUMER_KEY ||
        !MPESA_CONSUMER_SECRET ||
        !MPESA_SHORTCODE ||
        !MPESA_PASSKEY ||
        !MPESA_CALLBACK_URL
      ) {

        return res.status(
          500
        ).json({

          success:
            false,

          error:
            "M-PESA Sandbox configuration is incomplete."

        });
      }


      /* -----------------------------------------
         ORDER
      ----------------------------------------- */

      if (
        !orderId ||
        !String(orderId).trim()
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            "Order ID is required."

        });
      }

      const cleanOrderId =
        String(
          orderId
        ).trim();


      /* -----------------------------------------
         PHONE
      ----------------------------------------- */

      const normalizedPhone =
        normalizePhone(
          phone
        );

      if (!normalizedPhone) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            "Invalid Kenyan phone number."

        });
      }


      /* -----------------------------------------
         AMOUNT
      ----------------------------------------- */

      const numericAmount =
        Number(amount);

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount <= 0
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            "Invalid payment amount."

        });
      }

      const finalAmount =
        Math.round(
          numericAmount
        );


      /* -----------------------------------------
         ACCESS TOKEN
      ----------------------------------------- */

      console.log(
        "Getting Sandbox access token..."
      );

      const accessToken =
        await getAccessToken();

      console.log(
        "✅ Sandbox access token received."
      );


      /* -----------------------------------------
         TIMESTAMP
      ----------------------------------------- */

      const timestamp =
        getKenyaTimestamp();


      /* -----------------------------------------
         PASSWORD
      ----------------------------------------- */

      const password =
        Buffer.from(
          MPESA_SHORTCODE +
          MPESA_PASSKEY +
          timestamp
        ).toString(
          "base64"
        );


      /* -----------------------------------------
         REFERENCE
      ----------------------------------------- */

      const reference =
        createAccountReference(
          accountReference ||
          cleanOrderId
        );


      const description =
        String(
          transactionDesc ||
          "ANANDA Herbal"
        ).substring(
          0,
          20
        );


      /* -----------------------------------------
         STK REQUEST
      ----------------------------------------- */

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


      console.log(
        "Sandbox STK payload prepared."
      );

      console.log(
        "Callback URL:",
        MPESA_CALLBACK_URL
      );

      console.log(
        "Phone:",
        normalizedPhone
      );

      console.log(
        "Amount:",
        finalAmount
      );


      /* -----------------------------------------
         SEND STK
      ----------------------------------------- */

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


      console.log(
        "M-PESA SANDBOX RESPONSE:"
      );

      console.log(
        JSON.stringify(
          response.data,
          null,
          2
        )
      );


      const checkoutRequestId =
        response.data?.CheckoutRequestID;

      const merchantRequestId =
        response.data?.MerchantRequestID;

      const responseCode =
        response.data?.ResponseCode;


      /* -----------------------------------------
         REJECTED
      ----------------------------------------- */

      if (
        String(
          responseCode
        ) !== "0" ||
        !checkoutRequestId
      ) {

        return res.status(
          400
        ).json({

          success:
            false,

          error:
            response.data?.errorMessage ||
            response.data?.ResponseDescription ||
            "M-PESA Sandbox rejected the STK request.",

          responseCode:
            responseCode ||
            null,

          mpesaResponse:
            response.data

        });
      }


      /* -----------------------------------------
         SAVE ORDER
      ----------------------------------------- */

      const orders =
        readOrders();

      const now =
        new Date().toISOString();

      const existingIndex =
        orders.findIndex(
          order =>
            order.orderId ===
            cleanOrderId
        );


      const orderRecord = {

        orderId:
          cleanOrderId,

        merchantRequestId:
          merchantRequestId ||
          null,

        checkoutRequestId:
          checkoutRequestId ||
          null,

        name:
          name ||
          "",

        phone:
          normalizedPhone,

        email:
          email ||
          "",

        address:
          address ||
          "",

        city:
          city ||
          "",

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
          orders[
            existingIndex
          ].createdAt
            ? orders[
                existingIndex
              ].createdAt
            : now,

        updatedAt:
          now
      };


      if (
        existingIndex >= 0
      ) {

        orders[
          existingIndex
        ] = {

          ...orders[
            existingIndex
          ],

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
        "✅ PENDING ORDER SAVED:"
      );

      console.log(
        cleanOrderId
      );

      console.log(
        "CheckoutRequestID:",
        checkoutRequestId
      );


      return res.json({

        success:
          true,

        message:
          response.data?.CustomerMessage ||
          "STK Push sent successfully.",

        customerMessage:
          response.data?.CustomerMessage ||
          "Enter your M-PESA PIN to complete payment.",

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
        "======================================"
      );

      console.error(
        "❌ M-PESA SANDBOX STK ERROR"
      );

      console.error(
        "======================================"
      );

      if (
        error.response
      ) {

        console.error(
          "HTTP Status:",
          error.response.status
        );

        console.error(
          "Safaricom response:"
        );

        console.error(
          JSON.stringify(
            error.response.data,
            null,
            2
          )
        );

        return res.status(
          error.response.status ||
          500
        ).json({

          success:
            false,

          error:
            error.response.data?.errorMessage ||
            error.response.data?.ResponseDescription ||
            "M-PESA Sandbox request failed.",

          mpesaResponse:
            error.response.data

        });
      }


      console.error(
        error.message
      );


      return res.status(
        500
      ).json({

        success:
          false,

        error:
          error.message ||
          "M-PESA request failed."

      });
    }
  }
);


/* =========================================================
   M-PESA CALLBACK
========================================================= */

/*
 * PRIMARY CALLBACK:
 *
 * https://www.anandagreenherbary.co.ke/api/mpesa/callback
 *
 * This is the exact callback URL used by this server.
 *
 * The old /api/payment/callback route is also kept
 * below for compatibility.
 */

const handleMpesaCallback =
  async (req, res) => {

    console.log("");
    console.log(
      "======================================"
    );

    console.log(
      "M-PESA SANDBOX CALLBACK RECEIVED"
    );

    console.log(
      "======================================"
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
         CALLBACK METADATA
      ----------------------------------------- */

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


      /* -----------------------------------------
         FIND ORDER
      ----------------------------------------- */

      const orders =
        readOrders();

      const orderIndex =
        orders.findIndex(
          order =>
            order.checkoutRequestId ===
            checkoutRequestId
        );


      if (
        orderIndex === -1
      ) {

        console.error(
          "⚠️ No matching order for callback:",
          checkoutRequestId
        );

        return res.json({

          ResultCode:
            0,

          ResultDesc:
            "Accepted"

        });
      }


      const order =
        orders[
          orderIndex
        ];


      order.resultCode =
        resultCode;

      order.resultDesc =
        resultDesc;

      order.updatedAt =
        new Date().toISOString();


      /* -----------------------------------------
         PAYMENT SUCCESS
      ----------------------------------------- */

      if (
        resultCode === 0
      ) {

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
          "======================================"
        );

        console.log(
          "✅ M-PESA PAYMENT SUCCESSFUL"
        );

        console.log(
          "======================================"
        );

        console.log(
          "Order:",
          order.orderId
        );

        console.log(
          "Amount:",
          amount
        );

        console.log(
          "Receipt:",
          receiptNumber
        );


        writeOrders(
          orders
        );


        /* ---------------------------------------
           WHATSAPP
        --------------------------------------- */

        const whatsappResult =
          await sendWhatsAppOrderNotification(
            order,
            amount,
            receiptNumber
          );


        if (
          whatsappResult?.success
        ) {

          console.log(
            "✅ WhatsApp order notification sent."
          );

        } else {

          console.error(
            "⚠️ Payment succeeded but WhatsApp failed:",
            whatsappResult
          );
        }


      } else {

        order.status =
          "FAILED";


        writeOrders(
          orders
        );


        console.log(
          "❌ PAYMENT FAILED:"
        );

        console.log(
          "Code:",
          resultCode
        );

        console.log(
          "Description:",
          resultDesc
        );
      }


    } catch (error) {

      console.error(
        "❌ Callback processing error:",
        error
      );
    }


    /*
     * Always acknowledge Safaricom.
     */

    return res.json({

      ResultCode:
        0,

      ResultDesc:
        "Accepted"

    });
};


/* =========================================================
   CALLBACK ROUTES
========================================================= */

/*
 * PRIMARY CALLBACK
 *
 * IMPORTANT:
 * The public domain above must forward this path
 * to this Node/Express server.
 */

app.post(
  "/api/mpesa/callback",
  handleMpesaCallback
);


/*
 * COMPATIBILITY CALLBACK
 *
 * Kept in case an older configuration still uses it.
 */

app.post(
  "/api/payment/callback",
  handleMpesaCallback
);


/*
 * Simple browser check.
 * Safaricom sends POST, not GET.
 */

app.get(
  "/api/mpesa/callback",
  (req, res) => {

    res.json({

      success:
        true,

      message:
        "ANANDA M-PESA callback endpoint is running.",

      method:
        "POST",

      callbackUrl:
        MPESA_CALLBACK_URL,

      sandbox:
        true

    });

  }
);


/* =========================================================
   PAYMENT STATUS
========================================================= */

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  (req, res) => {

    try {

      const checkoutRequestId =
        req.params.checkoutRequestId;


      if (
        !checkoutRequestId
      ) {

        return res.status(
          400
        ).json({

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
          item =>
            item.checkoutRequestId ===
            checkoutRequestId
        );


      if (!order) {

        return res.status(
          404
        ).json({

          success:
            false,

          status:
            "NOT_FOUND",

          message:
            "Payment record not found"

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
          order.checkoutRequestId,

        updatedAt:
          order.updatedAt

      });


    } catch (error) {

      console.error(
        "Payment status error:",
        error
      );


      return res.status(
        500
      ).json({

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

    const orderId =
      req.params.orderId;

    const orders =
      readOrders();

    const order =
      orders.find(
        item =>
          item.orderId ===
          orderId
      );


    if (!order) {

      return res.status(
        404
      ).json({

        success:
          false,

        error:
          "Order not found"

      });
    }


    return res.json({

      success:
        true,

      order:
        order

    });
  }
);


/* =========================================================
   ALL ORDERS
========================================================= */

app.get(
  "/api/orders",
  (req, res) => {

    const orders =
      readOrders();

    res.json({

      success:
        true,

      count:
        orders.length,

      orders:
        orders

    });
  }
);


/* =========================================================
   FRONTEND
========================================================= */

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
      "======================================"
    );

    console.log(
      "ANANDA SERVER STARTED"
    );

    console.log(
      "======================================"
    );

    console.log(
      "Port:",
      PORT
    );

    console.log(
      "M-PESA MODE: SANDBOX"
    );

    console.log(
      "M-PESA URL:",
      MPESA_BASE_URL
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
      "WhatsApp configured:",
      Boolean(
        WHATSAPP_TOKEN &&
        WHATSAPP_PHONE_NUMBER_ID &&
        ADMIN_WHATSAPP_NUMBER
      )
    );

    console.log(
      "WhatsApp recipient:",
      normalizePhone(
        ADMIN_WHATSAPP_NUMBER
      )
    );

    console.log(
      "Callback URL:",
      MPESA_CALLBACK_URL
    );

    console.log(
      "Callback route:",
      "/api/mpesa/callback"
    );

    console.log(
      "======================================"
    );
  }
);
