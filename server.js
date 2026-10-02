/* =========================================================
   ANANDA GREEN HERBARY — SERVER
   =========================================================
   Complete server.js

   Features:
     - Express server
     - JSON file order store (orders.json)
     - M-Pesa STK Push  (POST /api/mpesa/stkpush)
     - M-Pesa Payment Status
       (GET /api/mpesa/payment/:checkoutRequestId)
     - M-Pesa Callback  (POST /api/mpesa/callback)
                        (POST /api/payment/callback)
     - WhatsApp Cloud API order notification
       (template-aware, with full error logging)
     - Test route       (GET /test-whatsapp)

   Requires:
     Node 18+   (global fetch)

   Env vars:
     PORT
     MPESA_ENV                     sandbox | production
     MPESA_CONSUMER_KEY
     MPESA_CONSUMER_SECRET
     MPESA_SHORTCODE
     MPESA_PASSKEY
     MPESA_CALLBACK_URL
     WHATSAPP_TOKEN
     WHATSAPP_PHONE_NUMBER_ID
     WHATSAPP_TEMPLATE_NAME
     WHATSAPP_TEMPLATE_LANG
     WHATSAPP_API_VERSION
     ADMIN_NOTIFY_PHONE           (optional — your own WhatsApp no.)
   ========================================================= */

"use strict";

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const app = express();

/* =========================================================
   APP SETUP
   ========================================================= */

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

/* Trust proxy (Render / Heroku / Nginx) so req.ip works. */
app.set("trust proxy", true);

/* Request logger (lightweight). */
app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );
  next();
});

/* =========================================================
   ORDER STORE  (JSON file)
   ========================================================= */

const ORDERS_FILE = path.join(__dirname, "orders.json");

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];

    const raw = fs.readFileSync(
      ORDERS_FILE,
      "utf8"
    );

    if (!raw.trim()) return [];

    const data = JSON.parse(raw);

    return Array.isArray(data)
      ? data
      : [];

  } catch (err) {

    console.error(
      "❌ readOrders failed:",
      err.message
    );

    return [];
  }
}


function writeOrders(orders) {

  try {

    const tmp =
      ORDERS_FILE + ".tmp";

    fs.writeFileSync(
      tmp,
      JSON.stringify(
        orders,
        null,
        2
      ),
      "utf8"
    );

    fs.renameSync(
      tmp,
      ORDERS_FILE
    );

  } catch (err) {

    console.error(
      "❌ writeOrders failed:",
      err.message
    );

  }

}


/* =========================================================
   M-PESA HELPERS
   ========================================================= */

const MPESA_ENV =
  (
    process.env.MPESA_ENV ||
    "sandbox"
  ).toLowerCase();


const MPESA_BASE =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";


const MPESA_TIMESTAMP = () => {

  const d =
    new Date();

  const p =
    (n) =>
      String(n).padStart(
        2,
        "0"
      );

  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );

};


async function getMpesaAccessToken() {

  const key =
    process.env.MPESA_CONSUMER_KEY;

  const secret =
    process.env.MPESA_CONSUMER_SECRET;


  if (!key || !secret) {

    throw new Error(
      "Missing MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET"
    );

  }


  const auth =
    Buffer
      .from(
        `${key}:${secret}`
      )
      .toString("base64");


  const resp =
    await fetch(
      `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Basic ${auth}`
        }
      }
    );


  const text =
    await resp.text();

  let data;

  try {

    data =
      JSON.parse(text);

  } catch {

    data = {
      raw: text
    };

  }


  if (
    !resp.ok ||
    !data.access_token
  ) {

    console.error(
      "❌ M-Pesa token error:",
      resp.status,
      data
    );

    throw new Error(
      "Failed to get M-Pesa access token"
    );

  }


  return data.access_token;

}


function normalizePhoneMpesa(phone) {

  if (!phone) return null;

  let p =
    String(phone)
      .replace(/\D/g, "");


  if (
    p.startsWith("0")
  ) {

    p =
      "254" +
      p.slice(1);

  } else if (
    p.startsWith("7") ||
    p.startsWith("1")
  ) {

    p =
      "254" + p;

  } else if (
    p.startsWith("2540")
  ) {

    p =
      "254" +
      p.slice(4);

  }


  return p;

}


/* =========================================================
   WHATSAPP HELPERS
   ========================================================= */

function normalizePhoneWhatsApp(phone) {

  if (
    phone === null ||
    phone === undefined
  ) {

    return null;

  }


  let p =
    String(phone)
      .replace(/\D/g, "");


  if (!p) return null;


  if (
    p.startsWith("0")
  ) {

    p =
      "254" +
      p.slice(1);

  } else if (
    p.startsWith("7") ||
    p.startsWith("1")
  ) {

    p =
      "254" +
      p;

  } else if (
    p.startsWith("2540")
  ) {

    p =
      "254" +
      p.slice(4);

  }


  return p;

}


/**
 * Send an order-confirmation WhatsApp message.
 *
 * Returns:
 *   {
 *     success,
 *     messageId?,
 *     error?,
 *     code?,
 *     subcode?,
 *     details?
 *   }
 */
async function sendWhatsAppOrderNotification(
  order,
  amount,
  receiptNumber
) {

  const token =
    process.env.WHATSAPP_TOKEN;


  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID;


  const templateName =
    process.env.WHATSAPP_TEMPLATE_NAME ||
    "";


  const templateLang =
    process.env.WHATSAPP_TEMPLATE_LANG ||
    "en";


  const apiVersion =
    process.env.WHATSAPP_API_VERSION ||
    "v21.0";


  const rawPhone =
    order?.customerPhone ||
    order?.phone ||
    order?.customer_phone ||
    order?.paidPhone ||
    null;


  const to =
    normalizePhoneWhatsApp(
      rawPhone
    );


  console.log("");
  console.log(
    "📲 WhatsApp notification"
  );
  console.log(
    "   order   :",
    order?.orderId
  );
  console.log(
    "   rawPhone:",
    rawPhone
  );
  console.log(
    "   to      :",
    to
  );
  console.log(
    "   amount  :",
    amount
  );
  console.log(
    "   receipt :",
    receiptNumber
  );


  if (!token) {

    const err =
      "Missing WHATSAPP_TOKEN env var";

    console.error(
      "⚠️",
      err
    );

    return {
      success: false,
      error: err
    };

  }


  if (!phoneNumberId) {

    const err =
      "Missing WHATSAPP_PHONE_NUMBER_ID env var";

    console.error(
      "⚠️",
      err
    );

    return {
      success: false,
      error: err
    };

  }


  if (!to) {

    const err =
      "No valid customer phone on order";

    console.error(
      "⚠️",
      err
    );

    return {
      success: false,
      error: err
    };

  }


  const url =
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;


  let payload;


  if (templateName) {

    /*
     * Template message — required for
     * business-initiated messages outside
     * the 24-hour customer service window.
     */

    payload = {

      messaging_product:
        "whatsapp",

      to,

      type:
        "template",

      template: {

        name:
          templateName,

        language: {
          code:
            templateLang
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
                    order?.orderId ??
                    ""
                  )
              },

              {
                type:
                  "text",

                text:
                  String(
                    amount ??
                    ""
                  )
              },

              {
                type:
                  "text",

                text:
                  String(
                    receiptNumber ??
                    "-"
                  )
              }

            ]

          }

        ]

      }

    };

  } else {

    /*
     * Fallback free-form text.
     * This only works inside the
     * 24-hour customer service window.
     */

    payload = {

      messaging_product:
        "whatsapp",

      to,

      type:
        "text",

      text: {

        preview_url:
          false,

        body:
`✅ Payment received

Order:   ${order?.orderId ?? ""}
Amount:  KES ${amount ?? ""}
Receipt: ${receiptNumber ?? "-"}

Thank you for your order!`

      }

    };

  }


  try {

    const resp =
      await fetch(
        url,
        {

          method:
            "POST",

          headers: {

            Authorization:
              `Bearer ${token}`,

            "Content-Type":
              "application/json"

          },

          body:
            JSON.stringify(
              payload
            )

        }
      );


    const rawText =
      await resp.text();


    let data;


    try {

      data =
        JSON.parse(
          rawText
        );

    } catch {

      data = {
        raw: rawText
      };

    }


    console.log(
      "📲 WhatsApp API status:",
      resp.status
    );


    console.log(
      "📲 WhatsApp API body:",
      JSON.stringify(
        data,
        null,
        2
      )
    );


    if (!resp.ok) {

      const apiErr =
        data?.error ||
        {};


      return {

        success:
          false,

        status:
          resp.status,

        error:
          apiErr.message ||
          "WhatsApp Graph API error",

        code:
          apiErr.code,

        subcode:
          apiErr.error_subcode,

        details:
          data

      };

    }


    return {

      success:
        true,

      messageId:
        data?.messages?.[0]?.id ||
        null,

      details:
        data

    };


  } catch (err) {

    console.error(
      "📲 WhatsApp fetch threw:",
      err
    );


    return {

      success:
        false,

      error:
        err?.message ||
        String(err)

    };

  }

}


/* =========================================================
   STK PUSH ROUTE
   =========================================================
   Client POSTs:
   {
     phone,
     amount,
     orderId?,
     customerName?,
     name?,
     email?,
     address?,
     city?,
     items?,
     accountReference?,
     transactionDesc?,
     notes?
   }

   Response:
   {
     success,
     orderId,
     checkoutRequestId,
     message
   }
   ========================================================= */

app.post(
  "/api/mpesa/stkpush",
  async (req, res) => {

    console.log("");
    console.log(
      "======================================"
    );
    console.log(
      "STK PUSH REQUEST"
    );
    console.log(
      "======================================"
    );


    try {

      const {

        phone,

        amount,

        orderId,

        customerName,

        name,

        email,

        address,

        city,

        items,

        accountReference,

        transactionDesc,

        notes

      } =
        req.body || {};


      if (
        !phone ||
        !amount
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "phone and amount are required"

          });

      }


      const msisdn =
        normalizePhoneMpesa(
          phone
        );


      const amt =
        Math.max(
          1,
          Math.round(
            Number(amount)
          )
        );


      if (!msisdn) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Invalid phone number"

          });

      }


      if (
        !Number.isFinite(amt) ||
        amt < 1
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              "Invalid amount"

          });

      }


      const shortcode =
        process.env.MPESA_SHORTCODE;


      const passkey =
        process.env.MPESA_PASSKEY;


      const callback =
        process.env.MPESA_CALLBACK_URL;


      if (
        !shortcode ||
        !passkey ||
        !callback
      ) {

        return res
          .status(500)
          .json({

            success:
              false,

            message:
              "Server misconfigured: MPESA_SHORTCODE / MPESA_PASSKEY / MPESA_CALLBACK_URL missing"

          });

      }


      const timestamp =
        MPESA_TIMESTAMP();


      const password =
        Buffer

          .from(
            `${shortcode}${passkey}${timestamp}`
          )

          .toString(
            "base64"
          );


      const token =
        await getMpesaAccessToken();


      const effectiveOrderId =
        orderId ||
        `ORD-${Date.now()}`;


      const stkBody = {

        BusinessShortCode:
          shortcode,

        Password:
          password,

        Timestamp:
          timestamp,

        TransactionType:
          "CustomerPayBillOnline",

        Amount:
          amt,

        PartyA:
          msisdn,

        PartyB:
          shortcode,

        PhoneNumber:
          msisdn,

        CallBackURL:
          callback,

        AccountReference:
          accountReference ||
          effectiveOrderId,

        TransactionDesc:
          transactionDesc ||
          "Payment for goods"

      };


      console.log(
        "STK body:",
        JSON.stringify(
          stkBody,
          null,
          2
        )
      );


      const stkResp =
        await fetch(

          `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,

          {

            method:
              "POST",

            headers: {

              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify(
                stkBody
              )

          }

        );


      const text =
        await stkResp.text();


      let stkData;


      try {

        stkData =
          JSON.parse(
            text
          );

      } catch {

        stkData = {
          raw: text
        };

      }


      console.log(
        "STK response:",
        JSON.stringify(
          stkData,
          null,
          2
        )
      );


      if (
        !stkResp.ok ||
        stkData.ResponseCode !== "0"
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              stkData.errorMessage ||
              stkData.ResponseDescription ||
              "STK push failed",

            details:
              stkData

          });

      }


      /* =====================================================
         SAVE THE PENDING ORDER
         ===================================================== */

      const orders =
        readOrders();


      const newOrder = {

        orderId:
          effectiveOrderId,

        customerName:
          customerName ||
          name ||
          null,

        customerPhone:
          phone,

        msisdn:
          msisdn,

        email:
          email ||
          null,

        address:
          address ||
          null,

        city:
          city ||
          null,

        items:
          Array.isArray(items)
            ? items
            : [],

        amount:
          amt,

        accountReference:
          accountReference ||
          effectiveOrderId,

        transactionDesc:
          transactionDesc ||
          "Payment for goods",

        notes:
          notes ||
          null,

        status:
          "PENDING",

        checkoutRequestId:
          stkData.CheckoutRequestID ||
          null,

        merchantRequestId:
          stkData.MerchantRequestID ||
          null,

        whatsappSent:
          false,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()

      };


      orders.push(
        newOrder
      );


      writeOrders(
        orders
      );


      return res.json({

        success:
          true,

        orderId:
          newOrder.orderId,

        checkoutRequestId:
          newOrder.checkoutRequestId,

        merchantRequestId:
          newOrder.merchantRequestId,

        message:
          "STK push sent. Enter PIN on your phone."

      });


    } catch (err) {

      console.error(
        "❌ STK push error:",
        err
      );


      return res
        .status(500)
        .json({

          success:
            false,

          message:
            err.message ||
            "Server error"

        });

    }

  }
);


/* =========================================================
   MARK ORDER PAID + SEND WHATSAPP ONCE
   ========================================================= */

async function markOrderPaidAndNotify(
  order,
  amount,
  receiptNumber,
  resultDesc =
    "Payment completed"
) {

  if (!order) {

    return {
      success:
        false,

      error:
        "Order not found"
    };

  }


  order.status =
    "PAID";


  order.mpesaReceiptNumber =
    receiptNumber ||
    order.mpesaReceiptNumber ||
    null;


  order.paidAmount =
    amount ??
    order.paidAmount ??
    order.amount ??
    null;


  order.resultCode =
    0;


  order.resultDesc =
    resultDesc;


  order.updatedAt =
    new Date().toISOString();


  const orders =
    readOrders();


  const index =
    orders.findIndex(
      o =>
        o.orderId ===
        order.orderId
    );


  if (index >= 0) {

    orders[index] = {

      ...orders[index],

      ...order

    };


    order =
      orders[index];


    writeOrders(
      orders
    );

  }


  /*
   * Send WhatsApp only once.
   *
   * This prevents duplicate messages when:
   *
   * 1. the status endpoint detects the payment
   * 2. Safaricom later sends the callback
   */

  if (
    order.whatsappSent
  ) {

    return {

      success:
        true,

      alreadySent:
        true,

      messageId:
        order.whatsappMessageId ||
        null

    };

  }


  try {

    const wa =
      await sendWhatsAppOrderNotification(
        order,
        order.paidAmount,
        order.mpesaReceiptNumber ||
        receiptNumber ||
        "-"
      );


    if (
      wa?.success
    ) {

      order.whatsappSent =
        true;


      order.whatsappMessageId =
        wa.messageId ||
        null;


      order.whatsappSentAt =
        new Date().toISOString();


      order.updatedAt =
        new Date().toISOString();


      const latestOrders =
        readOrders();


      const latestIndex =
        latestOrders.findIndex(
          o =>
            o.orderId ===
            order.orderId
        );


      if (
        latestIndex >= 0
      ) {

        latestOrders[
          latestIndex
        ] = {

          ...latestOrders[
            latestIndex
          ],

          ...order

        };


        writeOrders(
          latestOrders
        );

      }


      console.log(
        "✅ WhatsApp order notification sent. Message ID:",
        wa.messageId
      );


    } else {

      console.error(

        "⚠️ Payment succeeded but WhatsApp failed:",

        JSON.stringify(
          wa,
          null,
          2
        )

      );

    }


    return wa;


  } catch (waErr) {

    console.error(

      "⚠️ WhatsApp threw (payment is still recorded):",

      waErr

    );


    return {

      success:
        false,

      error:
        waErr?.message ||
        String(waErr)

    };

  }

}


/* =========================================================
   M-PESA PAYMENT STATUS
   =========================================================
   IMPORTANT:

   The ANANDA checkout page polls:

     /api/mpesa/payment/:checkoutRequestId

   after the STK Push.

   Returns:

     PENDING
     PAID
     FAILED

   This means the website does NOT have to wait for
   Safaricom's callback before recognizing a successful
   payment.

   ========================================================= */

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  async (req, res) => {

    const checkoutRequestId =
      req.params.checkoutRequestId;


    if (!checkoutRequestId) {

      return res
        .status(400)
        .json({

          success:
            false,

          status:
            "FAILED",

          message:
            "CheckoutRequestID is required."

        });

    }


    try {

      const orders =
        readOrders();


      let order =
        orders.find(

          o =>
            o.checkoutRequestId ===
            checkoutRequestId

        );


      /* =====================================================
         LOCAL STATUS ALREADY PAID
         ===================================================== */

      if (
        order &&
        String(
          order.status
        ).toUpperCase() ===
        "PAID"
      ) {

        return res.json({

          success:
            true,

          status:
            "PAID",

          orderId:
            order.orderId,

          payment: {

            mpesaReceipt:
              order.mpesaReceiptNumber ||
              null,

            amount:
              order.paidAmount ||
              order.amount ||
              null,

            phone:
              order.paidPhone ||
              order.customerPhone ||
              null,

            resultCode:
              order.resultCode ??
              0,

            resultDesc:
              order.resultDesc ||
              "Payment completed"

          }

        });

      }


      /* =====================================================
         LOCAL STATUS ALREADY FAILED
         ===================================================== */

      if (
        order &&
        String(
          order.status
        ).toUpperCase() ===
        "FAILED"
      ) {

        return res.json({

          success:
            true,

          status:
            "FAILED",

          orderId:
            order.orderId,

          payment: {

            resultCode:
              order.resultCode ??
              null,

            resultDesc:
              order.resultDesc ||
              "M-Pesa payment was not completed."

          }

        });

      }


      /* =====================================================
         CHECK REQUIRED M-PESA SETTINGS
         ===================================================== */

      const shortcode =
        process.env.MPESA_SHORTCODE;


      const passkey =
        process.env.MPESA_PASSKEY;


      if (
        !shortcode ||
        !passkey
      ) {

        console.error(
          "❌ Missing MPESA_SHORTCODE or MPESA_PASSKEY"
        );


        return res
          .status(500)
          .json({

            success:
              false,

            status:
              "PENDING",

            message:
              "M-Pesa configuration is incomplete."

          });

      }


      /* =====================================================
         CREATE STK QUERY REQUEST
         ===================================================== */

      const timestamp =
        MPESA_TIMESTAMP();


      const password =
        Buffer

          .from(
            `${shortcode}${passkey}${timestamp}`
          )

          .toString(
            "base64"
          );


      const token =
        await getMpesaAccessToken();


      const queryBody = {

        BusinessShortCode:
          shortcode,

        Password:
          password,

        Timestamp:
          timestamp,

        CheckoutRequestID:
          checkoutRequestId

      };


      console.log("");

      console.log(
        "🔎 Checking M-Pesa payment status:"
      );

      console.log(
        JSON.stringify(
          queryBody,
          null,
          2
        )
      );


      const response =
        await fetch(

          `${MPESA_BASE}/mpesa/stkpushquery/v1/query`,

          {

            method:
              "POST",

            headers: {

              Authorization:
                `Bearer ${token}`,

              "Content-Type":
                "application/json"

            },

            body:
              JSON.stringify(
                queryBody
              )

          }

        );


      const raw =
        await response.text();


      let data;


      try {

        data =
          JSON.parse(
            raw
          );

      } catch {

        data = {
          raw
        };

      }


      console.log(
        "🔎 M-Pesa query response:",
        JSON.stringify(
          data,
          null,
          2
        )
      );


      /* =====================================================
         TEMPORARY / NETWORK ERROR
         ===================================================== */

      if (
        !response.ok
      ) {

        return res.json({

          success:
            false,

          status:
            "PENDING",

          message:
            "Unable to verify payment yet. Retrying..."

        });

      }


      const resultCode =
        Number(
          data?.ResultCode
        );


      const resultDesc =
        data?.ResultDesc ||
        data?.errorMessage ||
        "";


      /* =====================================================
         PAYMENT CONFIRMED
         ===================================================== */

      if (
        resultCode === 0
      ) {

        /*
         * The normal STK flow should already have created
         * the local order.
         */

        if (!order) {

          /*
           * Defensive fallback.
           *
           * Normally this will NOT be used because the
           * STK Push route creates the order before returning
           * the CheckoutRequestID.
           */

          order = {

            orderId:
              checkoutRequestId,

            customerPhone:
              null,

            amount:
              null,

            status:
              "PENDING",

            checkoutRequestId:
              checkoutRequestId,

            createdAt:
              new Date().toISOString(),

            updatedAt:
              new Date().toISOString(),

            whatsappSent:
              false

          };


          orders.push(
            order
          );


          writeOrders(
            orders
          );

        }


        /*
         * This immediately marks the transaction as PAID
         * and sends the WhatsApp notification.
         */

        await markOrderPaidAndNotify(

          order,

          order.amount ??
          null,

          order.mpesaReceiptNumber ||
          null,

          resultDesc ||
          "Payment completed"

        );


        /*
         * Reload the order because markOrderPaidAndNotify()
         * may have updated whatsapp fields.
         */

        const refreshedOrders =
          readOrders();


        const refreshedOrder =
          refreshedOrders.find(

            o =>
              o.checkoutRequestId ===
              checkoutRequestId

          ) ||
          order;


        return res.json({

          success:
            true,

          status:
            "PAID",

          orderId:
            refreshedOrder.orderId,

          payment: {

            mpesaReceipt:
              refreshedOrder.mpesaReceiptNumber ||
              null,

            amount:
              refreshedOrder.paidAmount ||
              refreshedOrder.amount ||
              null,

            phone:
              refreshedOrder.paidPhone ||
              refreshedOrder.customerPhone ||
              null,

            resultCode:
              0,

            resultDesc:
              refreshedOrder.resultDesc ||
              resultDesc ||
              "Payment completed"

          }

        });

      }


      /* =====================================================
         UNKNOWN / STILL PROCESSING
         ===================================================== */

      if (
        !Number.isFinite(
          resultCode
        )
      ) {

        return res.json({

          success:
            true,

          status:
            "PENDING",

          message:
            "M-Pesa payment is still being processed."

        });

      }


      /* =====================================================
         PAYMENT FAILED / CANCELLED
         ===================================================== */

      if (
        order
      ) {

        order.status =
          "FAILED";

        order.resultCode =
          resultCode;

        order.resultDesc =
          resultDesc;

        order.updatedAt =
          new Date().toISOString();


        const currentIndex =
          orders.findIndex(

            o =>
              o.checkoutRequestId ===
              checkoutRequestId

          );


        if (
          currentIndex >= 0
        ) {

          orders[
            currentIndex
          ] = order;

        }


        writeOrders(
          orders
        );

      }


      return res.json({

        success:
          true,

        status:
          "FAILED",

        orderId:
          order?.orderId ||
          null,

        payment: {

          resultCode:

            resultCode,

          resultDesc:

            resultDesc ||

            "M-Pesa payment was not completed."

        }

      });


    } catch (error) {

      console.error(

        "❌ M-Pesa payment status error:",

        error

      );


      /*
       * A temporary status-check error must NOT be treated
       * as a payment failure.
       *
       * The frontend will keep polling.
       */

      return res.json({

        success:
          false,

        status:
          "PENDING",

        message:
          "Unable to check payment status. Retrying..."

      });

    }

  }
);


/* =========================================================
   M-PESA CALLBACK
   ========================================================= */

async function handleMpesaCallback(
  req,
  res
) {

  console.log("");

  console.log(
    "======================================"
  );

  console.log(
    "M-PESA CALLBACK RECEIVED"
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


    /* =====================================================
       EXTRACT CALLBACK METADATA
       ===================================================== */

    let receiptNumber =
      null;


    let transactionDate =
      null;


    let phoneNumber =
      null;


    let amount =
      null;


    const metadata =
      callback.CallbackMetadata?.Item;


    if (
      Array.isArray(
        metadata
      )
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


    /* =====================================================
       FIND ORDER
       ===================================================== */

    const orders =
      readOrders();


    const orderIndex =
      orders.findIndex(

        o =>
          o.checkoutRequestId ===
          checkoutRequestId

      );


    if (
      orderIndex ===
      -1
    ) {

      console.error(

        "⚠️ No matching order for callback:",

        checkoutRequestId

      );


      /*
       * Always acknowledge Safaricom.
       */

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


    /* =====================================================
       PAYMENT SUCCESS
       ===================================================== */

    if (
      resultCode ===
      0
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
        "Order  :",
        order.orderId
      );


      console.log(
        "Amount :",
        amount
      );


      console.log(
        "Receipt:",
        receiptNumber
      );


      /*
       * Mark paid and send WhatsApp ONCE.
       *
       * If the status endpoint already sent the message,
       * this function will detect whatsappSent === true
       * and will not send a duplicate.
       */

      await markOrderPaidAndNotify(

        order,

        amount,

        receiptNumber,

        resultDesc ||
        "Payment completed"

      );


      /*
       * Callback gives us the full payment metadata,
       * especially the receipt number.
       *
       * Persist it after the notification as well.
       */

      order.transactionDate =
        transactionDate;


      order.paidPhone =
        phoneNumber ||
        order.paidPhone ||
        null;


      order.updatedAt =
        new Date().toISOString();


      const latestOrders =
        readOrders();


      const latestIndex =
        latestOrders.findIndex(

          o =>
            o.orderId ===
            order.orderId

        );


      if (
        latestIndex >=
        0
      ) {

        latestOrders[
          latestIndex
        ] = {

          ...latestOrders[
            latestIndex
          ],

          ...order

        };


        writeOrders(
          latestOrders
        );

      }


    } else {

      /* ==================================================
         PAYMENT FAILED
         ================================================== */

      order.status =
        "FAILED";


      writeOrders(
        orders
      );


      console.log("");

      console.log(
        "❌ PAYMENT FAILED"
      );


      console.log(
        "Code        :",
        resultCode
      );


      console.log(
        "Description :",
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
   * ALWAYS acknowledge Safaricom.
   */

  return res.json({

    ResultCode:
      0,

    ResultDesc:
      "Accepted"

  });

}


/* =========================================================
   CALLBACK ROUTES
   ========================================================= */


/*
 * PRIMARY
 *
 * Must match:
 *
 * https://www.anandagreenherbary.co.ke/api/mpesa/callback
 */

app.post(
  "/api/mpesa/callback",
  handleMpesaCallback
);


/*
 * SECONDARY
 *
 * Legacy compatibility.
 */

app.post(
  "/api/payment/callback",
  handleMpesaCallback
);


/* =========================================================
   UTILITY ROUTES
   ========================================================= */

app.get(
  "/",
  (_req, res) => {

    res.json({

      ok:
        true,

      service:
        "ananda-green-herbary",

      time:
        new Date().toISOString()

    });

  }
);


app.get(
  "/health",
  (_req, res) => {

    res.json({
      ok:
        true
    });

  }
);


/*
 * List orders.
 *
 * Protect this route in production if it remains public.
 */

app.get(
  "/api/orders",
  (_req, res) => {

    res.json(
      readOrders()
    );

  }
);


/*
 * Lookup single order.
 */

app.get(
  "/api/orders/:orderId",
  (req, res) => {

    const order =
      readOrders()
        .find(
          o =>
            o.orderId ===
            req.params.orderId
        );


    if (!order) {

      return res
        .status(404)
        .json({

          ok:
            false,

          message:
            "Not found"

        });

    }


    res.json(
      order
    );

  }
);


/* =========================================================
   TEST ROUTE — WHATSAPP
   =========================================================
   Visit:

   /test-whatsapp?phone=2547XXXXXXXX

   Remove or protect this route in production.
   ========================================================= */

app.get(
  "/test-whatsapp",
  async (req, res) => {

    const phone =
      req.query.phone ||
      process.env.ADMIN_NOTIFY_PHONE;


    if (!phone) {

      return res
        .status(400)
        .json({

          ok:
            false,

          message:
            "Provide ?phone=2547XXXXXXXX or set ADMIN_NOTIFY_PHONE"

        });

    }


    const result =
      await sendWhatsAppOrderNotification(

        {
          orderId:
            "TEST-001",

          customerPhone:
            phone

        },

        10,

        "TESTRECEIPT"

      );


    res.json(
      result
    );

  }
);


/* =========================================================
   404 HANDLER
   ========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        ok:
          false,

        message:
          "Not found",

        path:
          req.originalUrl

      });

  }
);


/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {

    console.error(
      "❌ Unhandled error:",
      err
    );


    res
      .status(500)
      .json({

        ok:
          false,

        message:
          "Server error"

      });

  }
);


/* =========================================================
   START
   ========================================================= */

const PORT =
  process.env.PORT ||
  3000;


app.listen(
  PORT,
  () => {

    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      `🚀 Server listening on port ${PORT}`
    );

    console.log(
      `   M-Pesa env   : ${MPESA_ENV}`
    );

    console.log(
      `   Callback URL : ${
        process.env.MPESA_CALLBACK_URL ||
        "(not set)"
      }`
    );

    console.log(
      `   WhatsApp tmpl: ${
        process.env.WHATSAPP_TEMPLATE_NAME ||
        "(none — text fallback)"
      }`
    );

    console.log(
      "======================================"
    );

  }
);


/* =========================================================
   .env.example
   =========================================================

   PORT=3000

   # M-Pesa
   MPESA_ENV=sandbox
   MPESA_CONSUMER_KEY=xxxxxxxx
   MPESA_CONSUMER_SECRET=xxxxxxxx
   MPESA_SHORTCODE=174379
   MPESA_PASSKEY=xxxxxxxx
   MPESA_CALLBACK_URL=https://www.anandagreenherbary.co.ke/api/mpesa/callback

   # WhatsApp Cloud API
   WHATSAPP_TOKEN=EAAG...
   WHATSAPP_PHONE_NUMBER_ID=1234567890
   WHATSAPP_TEMPLATE_NAME=order_confirmation
   WHATSAPP_TEMPLATE_LANG=en
   WHATSAPP_API_VERSION=v21.0
   ADMIN_NOTIFY_PHONE=2547XXXXXXXX

   ========================================================= */
