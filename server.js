/* =========================================================
   ANANDA GREEN HERBARY — server.js
   M-PESA + WhatsApp order confirmation
   Node 18+
   ========================================================= */

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ORDERS_FILE = path.join(__dirname, "orders.json");

/* ---------------------------------------------------------
   CORS / BODY PARSING
   --------------------------------------------------------- */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,POST,OPTIONS"
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

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", true);

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );
  next();
});

/* ---------------------------------------------------------
   ORDER STORE
   --------------------------------------------------------- */

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
      `${ORDERS_FILE}.tmp`;

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

    return true;
  } catch (err) {
    console.error(
      "❌ writeOrders failed:",
      err.message
    );

    return false;
  }
}

/* ---------------------------------------------------------
   M-PESA HELPERS
   --------------------------------------------------------- */

const MPESA_ENV =
  String(
    process.env.MPESA_ENV ||
    "sandbox"
  ).toLowerCase();

const MPESA_BASE =
  MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

/*
 * Safaricom timestamp should be generated using
 * East Africa / Nairobi time.
 */
function nairobiTimestamp() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Africa/Nairobi",
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

  const get =
    (type) =>
      parts.find(
        p => p.type === type
      )?.value || "00";

  return (
    `${get("year")}` +
    `${get("month")}` +
    `${get("day")}` +
    `${get("hour")}` +
    `${get("minute")}` +
    `${get("second")}`
  );
}

/*
 * Accept:
 * 0723...
 * 254723...
 * +254723...
 * 723...
 */
function normalizeKenyaPhone(phone) {
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
      `254${p.slice(1)}`;
  } else if (
    p.startsWith("7") ||
    p.startsWith("1")
  ) {
    p =
      `254${p}`;
  }

  if (
    !/^254[17]\d{8}$/.test(p)
  ) {
    return null;
  }

  return p;
}

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

  const response =
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

  const raw =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    data = {
      raw
    };
  }

  if (
    !response.ok ||
    !data.access_token
  ) {
    console.error(
      "❌ M-Pesa token error:",
      response.status,
      data
    );

    throw new Error(
      data?.errorMessage ||
      "Failed to get M-Pesa access token"
    );
  }

  return data.access_token;
}

function envPresent(name) {
  return Boolean(
    String(
      process.env[name] || ""
    ).trim()
  );
}

/* ---------------------------------------------------------
   WHATSAPP CLOUD API
   --------------------------------------------------------- */

async function sendWhatsAppMessage({
  phone,
  orderId,
  amount,
  receipt
}) {
  const token =
    process.env.WHATSAPP_TOKEN;

  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID;

  const templateName =
    process.env.WHATSAPP_TEMPLATE_NAME;

  const templateLang =
    process.env.WHATSAPP_TEMPLATE_LANG ||
    "en";

  const apiVersion =
    process.env.WHATSAPP_API_VERSION ||
    "v24.0";

  const to =
    normalizeKenyaPhone(phone);

  console.log(
    "📲 WhatsApp send request:",
    {
      to,
      orderId,
      amount,
      receipt,
      templateName,
      phoneNumberId
    }
  );

  if (!token) {
    return {
      success: false,
      error:
        "Missing WHATSAPP_TOKEN"
    };
  }

  if (!phoneNumberId) {
    return {
      success: false,
      error:
        "Missing WHATSAPP_PHONE_NUMBER_ID"
    };
  }

  if (!to) {
    return {
      success: false,
      error:
        "Invalid WhatsApp destination phone"
    };
  }

  /*
   * Normal order confirmations should use
   * an approved WhatsApp template.
   */
  if (!templateName) {
    return {
      success: false,
      error:
        "Missing WHATSAPP_TEMPLATE_NAME. An approved WhatsApp template is required for order confirmations.",
      code:
        "MISSING_TEMPLATE"
    };
  }

  const url =
    `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const payload = {
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
                  orderId || ""
                )
            },

            {
              type:
                "text",

              text:
                String(
                  amount ?? ""
                )
            },

            {
              type:
                "text",

              text:
                String(
                  receipt || "-"
                )
            }
          ]
        }
      ]
    }
  };

  try {
    const response =
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

    const raw =
      await response.text();

    let data;

    try {
      data =
        JSON.parse(raw);
    } catch {
      data = {
        raw
      };
    }

    console.log(
      "📲 WhatsApp API status:",
      response.status
    );

    console.log(
      "📲 WhatsApp API body:",
      JSON.stringify(
        data,
        null,
        2
      )
    );

    if (!response.ok) {
      const apiError =
        data?.error || {};

      return {
        success: false,

        status:
          response.status,

        code:
          apiError.code ?? null,

        subcode:
          apiError.error_subcode ??
          null,

        error:
          apiError.message ||
          "WhatsApp Graph API error",

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
    return {
      success: false,

      error:
        err?.message ||
        String(err)
    };
  }
}

/* ---------------------------------------------------------
   SAVE PAID ORDER + SEND WHATSAPP
   --------------------------------------------------------- */

async function markOrderPaidAndNotify(
  order,
  amount,
  receiptNumber,
  resultDesc
) {
  if (!order) {
    return {
      success: false,
      error:
        "Order not found"
    };
  }

  /*
   * VERY IMPORTANT:
   * Save PAID before WhatsApp is attempted.
   * Therefore WhatsApp failure cannot erase the payment.
   */

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
    resultDesc ||
    "Payment completed";

  order.updatedAt =
    new Date().toISOString();

  let orders =
    readOrders();

  const idx =
    orders.findIndex(
      o =>
        o.orderId ===
        order.orderId
    );

  if (idx >= 0) {
    orders[idx] = {
      ...orders[idx],
      ...order
    };

    order =
      orders[idx];
  } else {
    orders.push(
      order
    );
  }

  writeOrders(
    orders
  );

  /* -------------------------------------------------------
     CUSTOMER WHATSAPP
     ------------------------------------------------------- */

  let customerResult =
    null;

  if (!order.whatsappSent) {
    customerResult =
      await sendWhatsAppMessage(
        {
          phone:
            order.customerPhone ||
            order.phone ||
            order.paidPhone,

          orderId:
            order.orderId,

          amount:
            order.paidAmount,

          receipt:
            order.mpesaReceiptNumber ||
            "-"
        }
      );

    if (
      customerResult.success
    ) {
      order.whatsappSent =
        true;

      order.whatsappMessageId =
        customerResult.messageId ||
        null;

      order.whatsappSentAt =
        new Date().toISOString();

      order.whatsappReceiptSent =
        order.mpesaReceiptNumber ||
        null;

      order.whatsappError =
        null;
    } else {
      order.whatsappSent =
        false;

      order.whatsappError =
        customerResult.error ||
        "WhatsApp send failed";

      order.whatsappErrorCode =
        customerResult.code ??
        null;

      order.whatsappErrorStatus =
        customerResult.status ??
        null;

      order.whatsappLastAttemptAt =
        new Date().toISOString();
    }
  }

  /* -------------------------------------------------------
     ADMIN / BUSINESS WHATSAPP
     ------------------------------------------------------- */

  const adminPhone =
    normalizeKenyaPhone(
      process.env.ADMIN_NOTIFY_PHONE
    );

  const customerPhone =
    normalizeKenyaPhone(
      order.customerPhone ||
      order.phone ||
      order.paidPhone
    );

  let adminResult =
    null;

  if (
    adminPhone &&
    adminPhone !== customerPhone &&
    !order.adminWhatsappSent
  ) {
    adminResult =
      await sendWhatsAppMessage(
        {
          phone:
            adminPhone,

          orderId:
            order.orderId,

          amount:
            order.paidAmount,

          receipt:
            order.mpesaReceiptNumber ||
            "-"
        }
      );

    if (
      adminResult.success
    ) {
      order.adminWhatsappSent =
        true;

      order.adminWhatsappMessageId =
        adminResult.messageId ||
        null;

      order.adminWhatsappSentAt =
        new Date().toISOString();

      order.adminWhatsappError =
        null;
    } else {
      order.adminWhatsappSent =
        false;

      order.adminWhatsappError =
        adminResult.error ||
        "Admin WhatsApp send failed";

      order.adminWhatsappErrorCode =
        adminResult.code ??
        null;
    }
  }

  order.updatedAt =
    new Date().toISOString();

  orders =
    readOrders();

  const latestIdx =
    orders.findIndex(
      o =>
        o.orderId ===
        order.orderId
    );

  if (latestIdx >= 0) {
    orders[latestIdx] = {
      ...orders[latestIdx],
      ...order
    };
  } else {
    orders.push(
      order
    );
  }

  writeOrders(
    orders
  );

  console.log(
    "✅ Payment recorded as PAID:",
    order.orderId
  );

  console.log(
    "📲 Customer WhatsApp result:",
    JSON.stringify(
      customerResult,
      null,
      2
    )
  );

  if (
    adminPhone &&
    adminPhone !== customerPhone
  ) {
    console.log(
      "📲 Admin WhatsApp result:",
      JSON.stringify(
        adminResult,
        null,
        2
      )
    );
  }

  return {
    success:
      Boolean(
        customerResult?.success
      ),

    paymentRecorded:
      true,

    customer:
      customerResult,

    admin:
      adminResult
  };
}

/* ---------------------------------------------------------
   M-PESA STK PUSH
   --------------------------------------------------------- */

app.post(
  "/api/mpesa/stkpush",
  async (req, res) => {
    try {
      const body =
        req.body || {};

      const phone =
        body.phone;

      const amount =
        Number(
          body.amount
        );

      if (
        !phone ||
        !Number.isFinite(amount) ||
        amount < 1
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "A valid phone and amount are required"
          });
      }

      const msisdn =
        normalizeKenyaPhone(
          phone
        );

      if (!msisdn) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Invalid Kenyan phone number"
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
              "Missing MPESA_SHORTCODE, MPESA_PASSKEY or MPESA_CALLBACK_URL"
          });
      }

      const amt =
        Math.round(
          amount
        );

      const timestamp =
        nairobiTimestamp();

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

      const orderId =
        body.orderId ||
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
          body.accountReference ||
          orderId,

        TransactionDesc:
          body.transactionDesc ||
          "Ananda Herbal Products"
      };

      console.log(
        "STK body:",
        JSON.stringify(
          stkBody,
          null,
          2
        )
      );

      const stkResponse =
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

      const raw =
        await stkResponse.text();

      let data;

      try {
        data =
          JSON.parse(raw);
      } catch {
        data = {
          raw
        };
      }

      console.log(
        "STK response:",
        JSON.stringify(
          data,
          null,
          2
        )
      );

      if (
        !stkResponse.ok ||
        String(
          data.ResponseCode
        ) !== "0"
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              data.errorMessage ||
              data.ResponseDescription ||
              "STK push failed",

            details:
              data
          });
      }

      const orders =
        readOrders();

      orders.push({
        orderId,

        customerName:
          body.customerName ||
          body.name ||
          null,

        customerPhone:
          body.phone,

        msisdn,

        email:
          body.email ||
          null,

        address:
          body.address ||
          null,

        city:
          body.city ||
          null,

        items:
          Array.isArray(
            body.items
          )
            ? body.items
            : [],

        amount:
          amt,

        accountReference:
          body.accountReference ||
          orderId,

        transactionDesc:
          body.transactionDesc ||
          "Ananda Herbal Products",

        notes:
          body.notes ||
          null,

        status:
          "PENDING",

        checkoutRequestId:
          data.CheckoutRequestID ||
          null,

        merchantRequestId:
          data.MerchantRequestID ||
          null,

        whatsappSent:
          false,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      });

      writeOrders(
        orders
      );

      return res.json({
        success:
          true,

        orderId,

        checkoutRequestId:
          data.CheckoutRequestID ||
          null,

        merchantRequestId:
          data.MerchantRequestID ||
          null,

        message:
          "STK push sent. Enter your M-Pesa PIN on the phone."
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

/* ---------------------------------------------------------
   M-PESA PAYMENT STATUS / QUERY
   --------------------------------------------------------- */

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
            "CheckoutRequestID is required"
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

      /*
       * Already recorded PAID locally.
       */

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

          whatsapp: {
            sent:
              order.whatsappSent === true,

            messageId:
              order.whatsappMessageId ||
              null,

            error:
              order.whatsappError ||
              null
          },

          payment: {
            mpesaReceipt:
              order.mpesaReceiptNumber ||
              null,

            amount:
              order.paidAmount ??
              order.amount ??
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

      /*
       * Already recorded FAILED locally.
       */

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
              "M-Pesa payment was not completed"
          }
        });
      }

      const shortcode =
        process.env.MPESA_SHORTCODE;

      const passkey =
        process.env.MPESA_PASSKEY;

      if (
        !shortcode ||
        !passkey
      ) {
        return res
          .status(500)
          .json({
            success:
              false,

            status:
              "PENDING",

            message:
              "M-Pesa configuration is incomplete"
          });
      }

      const timestamp =
        nairobiTimestamp();

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

      const queryResponse =
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
              JSON.stringify({
                BusinessShortCode:
                  shortcode,

                Password:
                  password,

                Timestamp:
                  timestamp,

                CheckoutRequestID:
                  checkoutRequestId
              })
          }
        );

      const raw =
        await queryResponse.text();

      let data;

      try {
        data =
          JSON.parse(raw);
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

      if (
        !queryResponse.ok
      ) {
        return res.json({
          success:
            false,

          status:
            "PENDING",

          message:
            "Unable to verify payment yet. Retrying...",

          details:
            data
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

      /*
       * SUCCESS
       */

      if (
        resultCode ===
        0
      ) {

        if (!order) {
          order = {
            orderId:
              checkoutRequestId,

            checkoutRequestId,

            status:
              "PENDING",

            customerPhone:
              null,

            amount:
              null,

            whatsappSent:
              false,

            createdAt:
              new Date().toISOString(),

            updatedAt:
              new Date().toISOString()
          };
        }

        await markOrderPaidAndNotify(
          order,

          order.amount ??
          null,

          order.mpesaReceiptNumber ||
          null,

          resultDesc ||
          "Payment completed"
        );

        const refreshed =
          readOrders()
            .find(
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
            refreshed.orderId,

          whatsapp: {
            sent:
              refreshed.whatsappSent ===
              true,

            messageId:
              refreshed.whatsappMessageId ||
              null,

            error:
              refreshed.whatsappError ||
              null
          },

          payment: {
            mpesaReceipt:
              refreshed.mpesaReceiptNumber ||
              null,

            amount:
              refreshed.paidAmount ??
              refreshed.amount ??
              null,

            phone:
              refreshed.paidPhone ||
              refreshed.customerPhone ||
              null,

            resultCode:
              0,

            resultDesc:
              refreshed.resultDesc ||
              resultDesc ||
              "Payment completed"
          }
        });
      }

      /*
       * UNKNOWN / STILL PROCESSING
       */

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
            "M-Pesa payment is still being processed"
        });
      }

      /*
       * FAILED
       */

      if (order) {
        order.status =
          "FAILED";

        order.resultCode =
          resultCode;

        order.resultDesc =
          resultDesc;

        order.updatedAt =
          new Date().toISOString();

        const idx =
          orders.findIndex(
            o =>
              o.checkoutRequestId ===
              checkoutRequestId
          );

        if (idx >= 0) {
          orders[idx] =
            order;
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
          resultCode,

          resultDesc:
            resultDesc ||
            "M-Pesa payment was not completed"
        }
      });

    } catch (err) {

      console.error(
        "❌ M-Pesa payment status error:",
        err
      );

      /*
       * Never turn a temporary server/network
       * problem into a false FAILED payment.
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

/* ---------------------------------------------------------
   M-PESA CALLBACK
   --------------------------------------------------------- */

async function handleMpesaCallback(
  req,
  res
) {
  console.log(
    "📥 M-PESA CALLBACK:",
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

    let receiptNumber =
      null;

    let transactionDate =
      null;

    let phoneNumber =
      null;

    let amount =
      null;

    const items =
      callback
        .CallbackMetadata
        ?.Item;

    if (
      Array.isArray(items)
    ) {
      for (
        const item of items
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

    const orders =
      readOrders();

    const idx =
      orders.findIndex(
        o =>
          o.checkoutRequestId ===
          checkoutRequestId
      );

    if (
      idx < 0
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
      orders[idx];

    order.resultCode =
      resultCode;

    order.resultDesc =
      resultDesc;

    order.updatedAt =
      new Date().toISOString();

    /*
     * PAYMENT SUCCESS
     */

    if (
      resultCode ===
      0
    ) {

      order.status =
        "PAID";

      order.mpesaReceiptNumber =
        receiptNumber ||
        order.mpesaReceiptNumber ||
        null;

      order.transactionDate =
        transactionDate;

      order.paidPhone =
        phoneNumber ||
        order.paidPhone ||
        null;

      order.paidAmount =
        amount ??
        order.paidAmount ??
        order.amount ??
        null;

      console.log(
        "✅ M-PESA PAYMENT SUCCESSFUL",
        {
          orderId:
            order.orderId,

          amount:
            order.paidAmount,

          receipt:
            order.mpesaReceiptNumber
        }
      );

      /*
       * If the status-query route marked the
       * order PAID before the callback arrived,
       * resend WhatsApp once the actual receipt
       * number becomes available.
       */

      const shouldRetryWithReceipt =
        order.whatsappSent === true &&
        Boolean(
          order.mpesaReceiptNumber
        ) &&
        order.whatsappReceiptSent !==
          order.mpesaReceiptNumber;

      if (
        shouldRetryWithReceipt
      ) {
        order.whatsappSent =
          false;
      }

      await markOrderPaidAndNotify(
        order,

        order.paidAmount,

        order.mpesaReceiptNumber,

        resultDesc ||
        "Payment completed"
      );

      const latest =
        readOrders();

      const latestIdx =
        latest.findIndex(
          o =>
            o.orderId ===
            order.orderId
        );

      if (
        latestIdx >=
        0
      ) {
        latest[latestIdx] =
          {
            ...latest[latestIdx],

            transactionDate:
              order.transactionDate,

            paidPhone:
              order.paidPhone,

            paidAmount:
              order.paidAmount,

            mpesaReceiptNumber:
              order.mpesaReceiptNumber,

            resultCode:
              order.resultCode,

            resultDesc:
              order.resultDesc,

            status:
              "PAID"
          };

        writeOrders(
          latest
        );
      }

    } else {

      /*
       * PAYMENT FAILED
       */

      order.status =
        "FAILED";

      writeOrders(
        orders
      );

      console.log(
        "❌ PAYMENT FAILED",
        resultCode,
        resultDesc
      );
    }

  } catch (err) {

    console.error(
      "❌ Callback processing error:",
      err
    );
  }

  /*
   * ALWAYS ACKNOWLEDGE SAFARICOM.
   */

  return res.json({
    ResultCode:
      0,

    ResultDesc:
      "Accepted"
  });
}

app.post(
  "/api/mpesa/callback",
  handleMpesaCallback
);

app.post(
  "/api/payment/callback",
  handleMpesaCallback
);

/* ---------------------------------------------------------
   ROOT / HEALTH
   --------------------------------------------------------- */

app.get(
  "/",
  (_req, res) => {
    res.json({

      ok:
        true,

      service:
        "ananda-green-herbary",

      mpesaConfigured:
        envPresent(
          "MPESA_CONSUMER_KEY"
        ) &&
        envPresent(
          "MPESA_CONSUMER_SECRET"
        ) &&
        envPresent(
          "MPESA_SHORTCODE"
        ) &&
        envPresent(
          "MPESA_PASSKEY"
        ) &&
        envPresent(
          "MPESA_CALLBACK_URL"
        ),

      whatsappConfigured:
        envPresent(
          "WHATSAPP_TOKEN"
        ) &&
        envPresent(
          "WHATSAPP_PHONE_NUMBER_ID"
        ),

      whatsappTemplateConfigured:
        envPresent(
          "WHATSAPP_TEMPLATE_NAME"
        ),

      time:
        new Date().toISOString()
    });
  }
);

app.get(
  "/health",
  (_req, res) =>
    res.json({
      ok:
        true
    })
);

/* ---------------------------------------------------------
   ORDERS
   --------------------------------------------------------- */

app.get(
  "/api/orders",
  (_req, res) =>
    res.json(
      readOrders()
    )
);

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

    return res.json(
      order
    );
  }
);

/* ---------------------------------------------------------
   SIMPLE ORDER STATUS
   --------------------------------------------------------- */

app.get(
  "/api/orders/:orderId/status",
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
          success:
            false,

          status:
            "NOT_FOUND",

          message:
            "Order not found"
        });
    }

    return res.json({

      success:
        true,

      status:
        String(
          order.status ||
          "PENDING"
        ).toUpperCase(),

      orderId:
        order.orderId,

      amount:
        order.paidAmount ??
        order.amount ??
        null,

      receipt:
        order.mpesaReceiptNumber ||
        null,

      whatsapp: {
        sent:
          order.whatsappSent ===
          true,

        messageId:
          order.whatsappMessageId ||
          null,

        error:
          order.whatsappError ||
          null
      },

      adminWhatsapp: {
        sent:
          order.adminWhatsappSent ===
          true,

        messageId:
          order.adminWhatsappMessageId ||
          null,

        error:
          order.adminWhatsappError ||
          null
      },

      updatedAt:
        order.updatedAt ||
        null
    });
  }
);

/* ---------------------------------------------------------
   WHATSAPP TEST
   --------------------------------------------------------- */

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
            "Use /test-whatsapp?phone=2547XXXXXXXX or set ADMIN_NOTIFY_PHONE"
        });
    }

    const result =
      await sendWhatsAppMessage({

        phone,

        orderId:
          "TEST-001",

        amount:
          10,

        receipt:
          "TESTRECEIPT"
      });

    return res.json(
      result
    );
  }
);

/* ---------------------------------------------------------
   404
   --------------------------------------------------------- */

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

/* ---------------------------------------------------------
   ERROR HANDLER
   --------------------------------------------------------- */

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

/* ---------------------------------------------------------
   START SERVER
   --------------------------------------------------------- */

app.listen(
  PORT,
  () => {

    console.log(
      "======================================"
    );

    console.log(
      `🚀 ANANDA SERVER STARTED on port ${PORT}`
    );

    console.log(
      `   M-Pesa env       : ${MPESA_ENV}`
    );

    console.log(
      `   Callback URL     : ${
        process.env.MPESA_CALLBACK_URL ||
        "(not set)"
      }`
    );

    console.log(
      `   WhatsApp Phone ID: ${
        process.env.WHATSAPP_PHONE_NUMBER_ID ||
        "(not set)"
      }`
    );

    console.log(
      `   WhatsApp template: ${
        process.env.WHATSAPP_TEMPLATE_NAME ||
        "(not set)"
      }`
    );

    console.log(
      "======================================"
    );
  }
);

/*
Environment variables:

MPESA_ENV=sandbox

MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://www.anandagreenherbary.co.ke/api/mpesa/callback

WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_TEMPLATE_NAME=...
WHATSAPP_TEMPLATE_LANG=en
WHATSAPP_API_VERSION=v24.0

ADMIN_NOTIFY_PHONE=2547XXXXXXXX
*/
