"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORDERS_FILE = path.join(__dirname, "orders.json");

// =========================================================
// M-PESA SANDBOX ONLY — DO NOT CHANGE TO PRODUCTION
// =========================================================
const MPESA_ENV = "sandbox";
const MPESA_BASE = "https://sandbox.safaricom.co.ke";

// =========================================================
// EMAIL NOTIFICATION
// =========================================================
const ADMIN_NOTIFY_EMAIL = "anandagreenherbary@gmail.com";

const EMAIL_ENABLED =
  String(
    process.env.EMAIL_ENABLED || "true"
  ).toLowerCase() === "true";

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  process.env.SMTP_USER ||
  ADMIN_NOTIFY_EMAIL;

const paymentLocks = new Set();

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

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

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use((req, _res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );

  next();
});

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) {
      return [];
    }

    const raw =
      fs.readFileSync(
        ORDERS_FILE,
        "utf8"
      );

    if (!raw.trim()) {
      return [];
    }

    const data =
      JSON.parse(raw);

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

function saveOrder(order) {
  const orders =
    readOrders();

  const idx =
    orders.findIndex(
      (o) =>
        o.orderId ===
        order.orderId
    );

  if (idx >= 0) {
    orders[idx] = {
      ...orders[idx],
      ...order
    };
  } else {
    orders.push(order);
  }

  return writeOrders(
    orders
  );
}

function envPresent(name) {
  return Boolean(
    String(
      process.env[name] || ""
    ).trim()
  );
}

function nairobiTimestamp() {
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

  const get =
    (type) =>
      parts.find(
        (p) =>
          p.type === type
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

  if (!p) {
    return null;
  }

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

function mpesaPassword(
  shortcode,
  passkey,
  timestamp
) {
  return Buffer
    .from(
      `${shortcode}${passkey}${timestamp}`
    )
    .toString("base64");
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
        method:
          "GET",

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
      data?.error_description ||
      "Failed to get M-Pesa access token"
    );
  }

  return data.access_token;
}

function extractCallbackMetadata(
  callback
) {
  const items =
    callback?.CallbackMetadata?.Item;

  const result = {
    receiptNumber:
      null,

    transactionDate:
      null,

    phoneNumber:
      null,

    amount:
      null
  };

  if (
    !Array.isArray(items)
  ) {
    return result;
  }

  for (
    const item of items
  ) {
    if (
      item?.Name ===
      "MpesaReceiptNumber"
    ) {
      result.receiptNumber =
        item.Value;
    }

    if (
      item?.Name ===
      "TransactionDate"
    ) {
      result.transactionDate =
        item.Value;
    }

    if (
      item?.Name ===
      "PhoneNumber"
    ) {
      result.phoneNumber =
        item.Value;
    }

    if (
      item?.Name ===
      "Amount"
    ) {
      result.amount =
        item.Value;
    }
  }

  return result;
}

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
    normalizeKenyaPhone(
      phone
    );

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
      success:
        false,

      error:
        "Missing WHATSAPP_TOKEN"
    };
  }

  if (!phoneNumberId) {
    return {
      success:
        false,

      error:
        "Missing WHATSAPP_PHONE_NUMBER_ID"
    };
  }

  if (!to) {
    return {
      success:
        false,

      error:
        "Invalid WhatsApp destination phone"
    };
  }

  if (!templateName) {
    return {
      success:
        false,

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
        success:
          false,

        status:
          response.status,

        code:
          apiError.code ??
          null,

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
      success:
        false,

      error:
        err?.message ||
        String(err)
    };
  }
}

async function sendPaidOrderEmail(
  order
) {
  if (!EMAIL_ENABLED) {
    return {
      success:
        false,

      skipped:
        true,

      error:
        "EMAIL_ENABLED is not true"
    };
  }

  const host =
    process.env.SMTP_HOST ||
    "smtp.gmail.com";

  const port =
    Number(
      process.env.SMTP_PORT ||
      465
    );

  const secure =
    String(
      process.env.SMTP_SECURE ||
      (
        port === 465
          ? "true"
          : "false"
      )
    ).toLowerCase() ===
    "true";

  const user =
    process.env.SMTP_USER ||
    ADMIN_NOTIFY_EMAIL;

  const pass =
    process.env.SMTP_PASS;

  if (!user || !pass) {
    return {
      success:
        false,

      error:
        "Missing SMTP_USER / SMTP_PASS"
    };
  }

  const transporter =
    nodemailer.createTransport({
      host,

      port,

      secure,

      auth: {
        user,
        pass
      }
    });

  const items =
    Array.isArray(
      order.items
    )
      ? order.items
      : [];

  const itemLines =
    items.length
      ? items
          .map(
            (item) =>
              `${item.name || "Item"} x${item.quantity || 1} - KES ${item.price || 0}`
          )
          .join("\n")
      : "No item details";

  const text = [
    "ANANDA GREEN HERBARY — PAID ORDER",
    "",
    `Order ID: ${order.orderId || "-"}`,
    `Status: ${order.status || "PAID"}`,
    `Customer: ${order.customerName || "-"}`,
    `Phone: ${order.customerPhone || "-"}`,
    `Email: ${order.email || "-"}`,
    `Address: ${order.address || "-"}`,
    `City: ${order.city || "-"}`,
    `Amount Paid: KES ${order.paidAmount ?? order.amount ?? "-"}`,
    `M-Pesa Receipt: ${order.mpesaReceiptNumber || "-"}`,
    `Payment Confirmed: ${order.paymentConfirmedAt || "-"}`,
    "",
    "Items:",
    itemLines,
    "",
    `Notes: ${order.notes || "-"}`
  ].join("\n");

  try {
    const info =
      await transporter.sendMail({
        from:
          EMAIL_FROM,

        to:
          ADMIN_NOTIFY_EMAIL,

        subject:
          `PAID ORDER ${order.orderId || ""}`,

        text
      });

    return {
      success:
        true,

      messageId:
        info.messageId ||
        null
    };
  } catch (err) {
    console.error(
      "❌ Paid order email failed:",
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
}async function markOrderPaidAndNotify(
  order,
  amount,
  receiptNumber,
  resultDesc,
  extra = {}
) {
  if (!order) {
    return {
      success:
        false,

      paymentRecorded:
        false,

      error:
        "Order not found"
    };
  }

  const lockKey =
    order.checkoutRequestId ||
    order.orderId;

  if (
    paymentLocks.has(
      lockKey
    )
  ) {
    const refreshed =
      readOrders().find(
        (o) =>
          o.orderId ===
          order.orderId
      ) || order;

    return {
      success:
        true,

      paymentRecorded:
        String(
          refreshed.status
        ).toUpperCase() ===
        "PAID",

      customer:
        null,

      admin:
        null,

      alreadyProcessing:
        true
    };
  }

  paymentLocks.add(
    lockKey
  );

  try {
    /*
      PAYMENT IS SAVED AS PAID BEFORE WHATSAPP.
      WHATSAPP FAILURE MUST NEVER CANCEL PAYMENT.
    */

    order.status =
      "PAID";

    if (
      receiptNumber
    ) {
      order.mpesaReceiptNumber =
        receiptNumber;
    } else {
      order.mpesaReceiptNumber =
        order.mpesaReceiptNumber ||
        null;
    }

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

    order.paymentConfirmedAt =
      order.paymentConfirmedAt ||
      new Date().toISOString();

    order.paymentConfirmationMethod =
      extra.method ||
      order.paymentConfirmationMethod ||
      "unknown";

    if (
      extra.transactionDate !=
      null
    ) {
      order.transactionDate =
        extra.transactionDate;
    }

    if (
      extra.paidPhone
    ) {
      order.paidPhone =
        extra.paidPhone;
    }

    saveOrder(order);

    let emailResult =
      null;

    if (
      !order.emailSent
    ) {
      emailResult =
        await sendPaidOrderEmail(
          order
        );

      if (
        emailResult.success
      ) {
        order.emailSent =
          true;

        order.emailMessageId =
          emailResult.messageId ||
          null;

        order.emailSentAt =
          new Date().toISOString();

        order.emailError =
          null;
      } else {
        order.emailSent =
          false;

        order.emailError =
          emailResult.error ||
          "Email notification failed";
      }

      order.emailLastAttemptAt =
        new Date().toISOString();

      saveOrder(order);
    }

    let customerResult =
      null;

    if (
      !order.whatsappSent
    ) {
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
      }

      order.whatsappLastAttemptAt =
        new Date().toISOString();
    }

    /*
      If the status-query confirmed PAID
      before the callback supplied the
      actual M-PESA receipt, send again
      once with the real receipt.
    */

    if (
      order.whatsappSent &&
      order.mpesaReceiptNumber &&
      order.whatsappReceiptSent !==
        order.mpesaReceiptNumber
    ) {
      const receiptRetry =
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
              order.mpesaReceiptNumber
          }
        );

      if (
        receiptRetry.success
      ) {
        order.whatsappMessageId =
          receiptRetry.messageId ||
          order.whatsappMessageId;

        order.whatsappSentAt =
          new Date().toISOString();

        order.whatsappReceiptSent =
          order.mpesaReceiptNumber;

        order.whatsappError =
          null;
      } else {
        order.whatsappError =
          receiptRetry.error ||
          "WhatsApp receipt update failed";

        order.whatsappErrorCode =
          receiptRetry.code ??
          null;

        order.whatsappErrorStatus =
          receiptRetry.status ??
          null;
      }

      order.whatsappLastAttemptAt =
        new Date().toISOString();
    }

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
      adminPhone !==
        customerPhone &&
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
          "Admin WhatsApp notification failed";

        order.adminWhatsappErrorCode =
          adminResult.code ??
          null;

        order.adminWhatsappErrorStatus =
          adminResult.status ??
          null;
      }

      order.adminWhatsappLastAttemptAt =
        new Date().toISOString();
    }

    saveOrder(order);

    return {
      success:
        true,

      paymentRecorded:
        true,

      orderId:
        order.orderId,

      status:
        order.status,

      mpesaReceipt:
        order.mpesaReceiptNumber,

      amount:
        order.paidAmount,

      email:
        emailResult,

      whatsapp:
        customerResult,

      adminWhatsapp:
        adminResult
    };

  } finally {
    paymentLocks.delete(
      lockKey
    );
  }
}/* =========================================================
   M-PESA PAYMENT STATUS
   ========================================================= */

app.get(
  "/api/mpesa/payment/:checkoutRequestId",
  async (req, res) => {

    const checkoutRequestId =
      String(
        req.params.checkoutRequestId ||
        ""
      ).trim();

    if (!checkoutRequestId) {
      return res.status(400).json({
        success:
          false,

        status:
          "PENDING",

        message:
          "Missing CheckoutRequestID"
      });
    }

    try {

      /*
        FIRST: check our own order database.

        If the callback has already confirmed
        the payment as PAID, that saved PAID
        status takes priority.

        This prevents a later status query from
        changing an already-paid order to FAILED.
      */

      let order =
        readOrders().find(
          (o) =>
            o.checkoutRequestId ===
            checkoutRequestId
        ) || null;


      if (
        order &&
        String(
          order.status || ""
        ).toUpperCase() ===
        "PAID"
      ) {

        console.log(
          "✅ PAYMENT ALREADY CONFIRMED:",
          {
            orderId:
              order.orderId,

            checkoutRequestId,

            receipt:
              order.mpesaReceiptNumber ||
              null
          }
        );

        return res.json(
          paymentResponse(
            order
          )
        );
      }


      /*
        Get a fresh M-Pesa access token.
      */

      const token =
        await getMpesaAccessToken();


      const shortcode =
        process.env.MPESA_SHORTCODE;

      const passkey =
        process.env.MPESA_PASSKEY;


      if (
        !shortcode ||
        !passkey
      ) {

        return res.status(500).json({
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
        mpesaPassword(
          shortcode,
          passkey,
          timestamp
        );


      /*
        Ask Safaricom for the current
        STK transaction status.
      */

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


      /*
        A failed HTTP request does NOT mean
        that the customer's payment failed.
      */

      if (
        !queryResponse.ok
      ) {

        /*
          Before returning PENDING, check
          our database one more time.

          The Safaricom callback may have arrived
          while this query was running.
        */

        const latestOrder =
          readOrders().find(
            (o) =>
              o.checkoutRequestId ===
              checkoutRequestId
          ) || null;


        if (
          latestOrder &&
          String(
            latestOrder.status || ""
          ).toUpperCase() ===
          "PAID"
        ) {

          return res.json(
            paymentResponse(
              latestOrder
            )
          );
        }


        return res.json({
          success:
            false,

          status:
            "PENDING",

          orderId:
            order?.orderId ||
            null,

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
        =====================================================
        RESULT CODE 0
        =====================================================
      */

      if (
        Number.isFinite(
          resultCode
        ) &&
        resultCode === 0
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

            adminWhatsappSent:
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
            "Payment completed",

          {
            method:
              "status-query"
          }
        );


        const refreshed =
          readOrders().find(
            (o) =>
              o.checkoutRequestId ===
              checkoutRequestId
          ) || order;


        return res.json(
          paymentResponse(
            refreshed
          )
        );
      }


      /*
        =====================================================
        NON-ZERO RESULT CODE
        =====================================================

        IMPORTANT:

        Do NOT immediately mark the order FAILED.

        The callback is the authoritative payment
        confirmation and may still arrive.

        We return PENDING while the order has not
        been independently confirmed as failed.
      */

      if (
        Number.isFinite(
          resultCode
        )
      ) {

        /*
          Check the order again before returning.
        */

        const latestOrder =
          readOrders().find(
            (o) =>
              o.checkoutRequestId ===
              checkoutRequestId
          ) || order;


        /*
          A callback may have changed the order
          to PAID between the first database check
          and this point.
        */

        if (
          latestOrder &&
          String(
            latestOrder.status || ""
          ).toUpperCase() ===
          "PAID"
        ) {

          return res.json(
            paymentResponse(
              latestOrder
            )
          );
        }


        /*
          Keep it PENDING.

          The callback will determine the final
          payment result.
        */

        return res.json({
          success:
            true,

          status:
            "PENDING",

          orderId:
            latestOrder?.orderId ||
            null,

          payment: {
            resultCode,

            resultDesc:
              resultDesc ||
              "M-Pesa transaction is still being processed"
          },

          message:
            "M-Pesa transaction is still being processed. Waiting for final confirmation."
        });
      }


      /*
        No usable result code yet.
      */

      const latestOrder =
        readOrders().find(
          (o) =>
            o.checkoutRequestId ===
            checkoutRequestId
        ) || order;


      /*
        Final database check.
      */

      if (
        latestOrder &&
        String(
          latestOrder.status || ""
        ).toUpperCase() ===
        "PAID"
      ) {

        return res.json(
          paymentResponse(
            latestOrder
          )
        );
      }


      return res.json({
        success:
          true,

        status:
          "PENDING",

        orderId:
          latestOrder?.orderId ||
          null,

        message:
          "M-Pesa payment is still being processed"
      });

    } catch (err) {

      console.error(
        "❌ M-Pesa payment status error:",
        err
      );


      /*
        Never convert a temporary
        verification/network problem
        into FAILED.
      */

      const latestOrder =
        readOrders().find(
          (o) =>
            o.checkoutRequestId ===
            checkoutRequestId
        ) || null;


      if (
        latestOrder &&
        String(
          latestOrder.status || ""
        ).toUpperCase() ===
        "PAID"
      ) {

        return res.json(
          paymentResponse(
            latestOrder
          )
        );
      }


      return res.json({
        success:
          false,

        status:
          "PENDING",

        orderId:
          latestOrder?.orderId ||
          null,

        message:
          "Unable to check payment status. Retrying..."
      });
    }
  }
);
