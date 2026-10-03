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

  if (!pass) {
    return {
      success:
        false,

      error:
        "Missing SMTP_PASS"
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
    ) &&
    order.items.length
      ? order.items
          .map(
            (
              item,
              i
            ) => {
              if (
                typeof item ===
                "string"
              ) {
                return `${i + 1}. ${item}`;
              }

              return (
                `${i + 1}. ` +
                `${item.name || item.productName || "Item"} ` +
                `x ${item.quantity || 1}` +
                (
                  item.price !=
                  null
                    ? ` @ ${item.price}`
                    : ""
                )
              );
            }
          )
          .join("\n")
      : "No item details supplied";

  const text = [
    "ANANDA HERBAL — PAID ORDER NOTIFICATION",
    "",

    `Order ID: ${order.orderId || "-"}`,

    `Status: ${order.status || "PAID"}`,

    `Amount Paid: ${
      order.paidAmount ??
      order.amount ??
      "-"
    }`,

    `M-Pesa Receipt: ${
      order.mpesaReceiptNumber ||
      "-"
    }`,

    `Paid Phone: ${
      order.paidPhone ||
      order.customerPhone ||
      order.phone ||
      "-"
    }`,

    `Customer: ${
      order.customerName ||
      "-"
    }`,

    `Customer Email: ${
      order.email ||
      "-"
    }`,

    `Address: ${
      order.address ||
      "-"
    }`,

    `City: ${
      order.city ||
      "-"
    }`,

    `Transaction Date: ${
      order.transactionDate ||
      "-"
    }`,

    `Confirmed At: ${
      order.paymentConfirmedAt ||
      "-"
    }`,

    "",

    "Items:",

    items,

    "",

    `Notes: ${
      order.notes ||
      "-"
    }`
  ].join("\n");

  try {
    const info =
      await transporter.sendMail({
        from:
          EMAIL_FROM,

        to:
          ADMIN_NOTIFY_EMAIL,

        subject:
          `PAID ORDER - ${
            order.orderId ||
            "Ananda Order"
          }`,

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
    return {
      success:
        false,

      error:
        err?.message ||
        String(err)
    };
  }
}

async function markOrderPaidAndNotify(
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
    ) {      adminResult =
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

        order.adminWhatsappErrorStatus =
          adminResult.status ??
          null;
      }

      order.adminWhatsappLastAttemptAt =
        new Date().toISOString();
    }

    order.updatedAt =
      new Date().toISOString();

    saveOrder(order);

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
      adminPhone !==
        customerPhone
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
        true,

      paymentRecorded:
        true,

      customer:
        customerResult,

      admin:
        adminResult,

      email:
        emailResult
    };
  } finally {
    paymentLocks.delete(
      lockKey
    );
  }
}

function markOrderFailed(
  order,
  resultCode,
  resultDesc
) {
  if (!order) {
    return false;
  }

  order.status =
    "FAILED";

  order.resultCode =
    resultCode;

  order.resultDesc =
    resultDesc ||
    "M-Pesa payment was not completed";

  order.updatedAt =
    new Date().toISOString();

  return saveOrder(
    order
  );
}

function paymentResponse(
  order
) {
  return {
    success:
      true,

    status:
      String(
        order?.status ||
        "PENDING"
      ).toUpperCase(),

    orderId:
      order?.orderId ||
      null,

    payment: {
      mpesaReceipt:
        order?.mpesaReceiptNumber ||
        null,

      amount:
        order?.paidAmount ??
        order?.amount ??
        null,

      phone:
        order?.paidPhone ||
        order?.customerPhone ||
        null,

      resultCode:
        order?.resultCode ??
        null,

      resultDesc:
        order?.resultDesc ||
        null
    },

    whatsapp: {
      sent:
        order?.whatsappSent ===
        true,

      messageId:
        order?.whatsappMessageId ||
        null,

      error:
        order?.whatsappError ||
        null
    },

    adminWhatsapp: {
      sent:
        order?.adminWhatsappSent ===
        true,

      messageId:
        order?.adminWhatsappMessageId ||
        null,

      error:
        order?.adminWhatsappError ||
        null
    },

    email: {
      sent:
        order?.emailSent ===
        true,

      messageId:
        order?.emailMessageId ||
        null,

      recipient:
        ADMIN_NOTIFY_EMAIL,

      error:
        order?.emailError ||
        null
    },

    updatedAt:
      order?.updatedAt ||
      null,

    paymentConfirmedAt:
      order?.paymentConfirmedAt ||
      null,

    paymentConfirmationMethod:
      order?.paymentConfirmationMethod ||
      null
  };
}

/* =========================================================
   M-PESA TILL / MANUAL PAYMENT
   Till Number: 5475967
   Delivery charge: KES 300
   The customer enters the M-PESA transaction code after paying.
   ========================================================= */

function normalizeMpesaCode(code) {
  const value = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

  if (!/^[A-Z0-9]{8,20}$/.test(value)) {
    return null;
  }

  return value;
}

async function sendCustomerOrderSms(order) {
  const username =
    process.env.AT_USERNAME ||
    process.env.AFRICASTALKING_USERNAME;

  const apiKey =
    process.env.AT_API_KEY ||
    process.env.AFRICASTALKING_API_KEY;

  // Use the approved ANANDA Sender ID when the Africa's Talking account permits it.
  // Kenya Sender IDs are limited to 11 characters, so the full
  // "ANANDA Green Herbary" cannot be used as an alphanumeric Sender ID.
  const senderId =
    process.env.AT_SENDER_ID ||
    process.env.AFRICASTALKING_SENDER_ID ||
    "ANANDA";

  const to = normalizeKenyaPhone(order.customerPhone);

  if (!username || !apiKey) {
    return {
      success: false,
      skipped: true,
      error: "Africa's Talking SMS is not configured. Set AT_USERNAME and AT_API_KEY."
    };
  }

  if (!to) {
    return {
      success: false,
      error: "Invalid customer phone number for SMS."
    };
  }

  const message = [
    "ANANDA Green Herbary:",
    `Thank you ${order.customerName || "Customer"}. Your order ${order.orderId} has been received.`,
    `M-PESA code: ${order.mpesaTransactionCode || "-"}.`,
    `Amount: KES ${Number(order.amount || 0).toLocaleString()}.`,
    "We will verify your payment and process your delivery. Thank you for choosing ANANDA."
  ].join(" ");

  const body = new URLSearchParams();
  body.set("username", username);
  body.set("to", to);
  body.set("message", message);
  if (senderId) body.set("from", senderId);

  try {
    const response = await fetch(
      "https://api.africastalking.com/version1/messaging",
      {
        method: "POST",
        headers: {
          "apiKey": apiKey,
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );

    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    console.log("📱 Africa's Talking SMS status:", response.status);
    console.log("📱 Africa's Talking SMS response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: data?.SMSMessageData?.Message || data?.message || raw || "SMS request failed"
      };
    }

    const recipient = data?.SMSMessageData?.Recipients?.[0] || {};

    return {
      success: String(recipient.statusCode || "").toLowerCase() === "101" || response.ok,
      messageId: recipient.messageId || null,
      cost: recipient.cost || null,
      statusCode: recipient.statusCode || null,
      response: data
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || String(err)
    };
  }
}

async function sendManualPaymentSubmissionEmail(order) {
  if (!EMAIL_ENABLED) {
    return {
      success:false,
      skipped:true,
      error:"EMAIL_ENABLED is not true"
    };
  }

  const host =
    process.env.SMTP_HOST ||
    "smtp.gmail.com";

  const port =
    Number(
      process.env.SMTP_PORT || 465
    );

  const secure =
    String(
      process.env.SMTP_SECURE ||
      (port === 465 ? "true" : "false")
    ).toLowerCase() === "true";

  const user =
    process.env.SMTP_USER ||
    ADMIN_NOTIFY_EMAIL;

  const pass =
    process.env.SMTP_PASS;

  if (!pass) {
    return {
      success:false,
      error:"Missing SMTP_PASS"
    };
  }

  const transporter =
    nodemailer.createTransport({
      host,
      port,
      secure,
      auth:{
        user,
        pass
      }
    });

  const items =
    Array.isArray(order.items) && order.items.length
      ? order.items.map((item,i)=>{
          if(typeof item === "string"){
            return `${i+1}. ${item}`;
          }
          return (
            `${i+1}. ${item.name || item.productName || "Item"} ` +
            `x ${item.quantity || 1}` +
            (item.price != null ? ` @ ${item.price}` : "")
          );
        }).join("\n")
      : "No item details supplied";

  const text = [
    "ANANDA HERBAL — NEW TILL PAYMENT ORDER",
    "",
    `Order ID: ${order.orderId || "-"}`,
    `Status: ${order.status || "PAYMENT_SUBMITTED"}`,
    `Till Number: ${order.tillNumber || "5475967"}`,
    `M-PESA Transaction Code: ${order.mpesaTransactionCode || "-"}`,
    `Amount Submitted: ${order.amount ?? "-"}`,
    `Delivery Fee: ${order.deliveryFee ?? 300}`,
    `Customer Phone: ${order.customerPhone || "-"}`,
    `Customer: ${order.customerName || "-"}`,
    `Customer Email: ${order.email || "-"}`,
    `Address: ${order.address || "-"}`,
    `City: ${order.city || "-"}`,
    "",
    "Items:",
    items,
    "",
    "The customer has submitted an M-PESA Till payment code.",
    "Verify the transaction in M-PESA before dispatching the order."
  ].join("\n");

  try {
    const info =
      await transporter.sendMail({
        from:EMAIL_FROM,
        to:ADMIN_NOTIFY_EMAIL,
        subject:`NEW TILL ORDER - ${order.orderId || "Ananda Order"}`,
        text
      });

    return {
      success:true,
      messageId:info.messageId || null
    };
  } catch(err) {
    return {
      success:false,
      error:err?.message || String(err)
    };
  }
}

app.post(
  "/api/mpesa/manual-payment",
  async (req,res)=>{
    try {
      const body=req.body || {};

      const name=String(body.name || "").trim();
      const phone=String(body.phone || "").trim();
      const email=String(body.email || "").trim();
      const address=String(body.address || "").trim();
      const city=String(body.city || "").trim();
      const mpesaCode=normalizeMpesaCode(body.mpesaCode);
      const amount=Math.round(Number(body.amount));
      const deliveryFee=300;
      const tillNumber="5475967";

      if(!name || !phone || !address){
        return res.status(400).json({
          success:false,
          message:"Name, phone and delivery address are required."
        });
      }

      if(!mpesaCode){
        return res.status(400).json({
          success:false,
          message:"A valid M-PESA transaction code is required."
        });
      }

      if(!Number.isFinite(amount) || amount < deliveryFee){
        return res.status(400).json({
          success:false,
          message:"Invalid order amount."
        });
      }

      const items =
        Array.isArray(body.items)
          ? body.items
          : [];

      if(!items.length){
        return res.status(400).json({
          success:false,
          message:"Your order has no items."
        });
      }

      const orderId =
        String(body.orderId || `ANANDA-${Date.now()}`)
          .trim();

      /*
        Do not mark the order PAID merely because the customer typed a code.
        A Till payment has no STK callback linked to this website.
        The order is recorded as PAYMENT_SUBMITTED and must be verified
        against the M-PESA transaction before dispatch.
      */
      const existing =
        readOrders().find(
          o=>o.orderId===orderId
        );

      if(existing){
        return res.status(409).json({
          success:false,
          message:"This order has already been submitted."
        });
      }

      const order={
        orderId,
        customerName:name,
        customerPhone:phone,
        email:email || null,
        address,
        city,
        items,
        amount,
        deliveryFee,
        tillNumber,
        mpesaTransactionCode:mpesaCode,
        accountReference:
          body.accountReference || orderId,
        transactionDesc:
          body.transactionDesc ||
          "ANANDA Herbal Products",
        status:"PAYMENT_SUBMITTED",
        paymentConfirmationMethod:"customer-till-code",
        paymentVerified:false,
        paymentConfirmedAt:null,
        whatsappSent:false,
        adminWhatsappSent:false,
        emailSent:false,
        createdAt:new Date().toISOString(),
        updatedAt:new Date().toISOString()
      };

      if(!saveOrder(order)){
        return res.status(500).json({
          success:false,
          message:"Order could not be saved."
        });
      }

      const smsResult =
        await sendCustomerOrderSms(order);

      if(smsResult.success){
        order.customerSmsSent=true;
        order.customerSmsMessageId=smsResult.messageId || null;
        order.customerSmsCost=smsResult.cost || null;
        order.customerSmsStatusCode=smsResult.statusCode || null;
        order.customerSmsSentAt=new Date().toISOString();
        order.customerSmsError=null;
      }else{
        order.customerSmsSent=false;
        order.customerSmsError=smsResult.error || "Customer SMS failed";
        order.customerSmsLastAttemptAt=new Date().toISOString();
      }

      const emailResult =
        await sendManualPaymentSubmissionEmail(order);

      if(emailResult.success){
        order.emailSent=true;
        order.emailMessageId=emailResult.messageId || null;
        order.emailSentAt=new Date().toISOString();
        order.emailError=null;
      }else{
        order.emailSent=false;
        order.emailError=emailResult.error || "Email notification failed";
        order.emailLastAttemptAt=new Date().toISOString();
      }

      /*
        If an admin WhatsApp number and approved template are configured,
        send the same transaction code in the receipt parameter.
      */
      const adminPhone =
        normalizeKenyaPhone(
          process.env.ADMIN_NOTIFY_PHONE
        );

      if(adminPhone){
        const adminResult =
          await sendWhatsAppMessage({
            phone:adminPhone,
            orderId:order.orderId,
            amount:order.amount,
            receipt:order.mpesaTransactionCode
          });

        if(adminResult.success){
          order.adminWhatsappSent=true;
          order.adminWhatsappMessageId=
            adminResult.messageId || null;
          order.adminWhatsappSentAt=
            new Date().toISOString();
          order.adminWhatsappError=null;
        }else{
          order.adminWhatsappSent=false;
          order.adminWhatsappError=
            adminResult.error ||
            "Admin WhatsApp send failed";
        }
      }

      order.updatedAt=new Date().toISOString();
      saveOrder(order);

      console.log(
        "🧾 TILL PAYMENT SUBMITTED:",
        {
          orderId:order.orderId,
          tillNumber,
          amount,
          mpesaCode
        }
      );

      return res.json({
        success:true,
        orderId:order.orderId,
        status:order.status,
        tillNumber,
        deliveryFee,
        amount,
        message:
          "Order received. M-PESA transaction code submitted for verification."
      });

    } catch(err) {
      console.error(
        "❌ Manual Till payment error:",
        err
      );

      return res.status(500).json({
        success:false,
        message:err?.message || "Server error"
      });
    }
  }
);

/* =========================================================
   M-PESA STK PUSH
   ========================================================= */

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
        !Number.isFinite(
          amount
        ) ||
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
        mpesaPassword(
          shortcode,
          passkey,
          timestamp
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
        "📤 STK body:",
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
        "📤 STK response:",
        JSON.stringify(
          data,
          null,
          2
        )
      );

      if (
        !stkResponse.ok ||
        String(
          data?.ResponseCode
        ) !== "0"
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              data?.errorMessage ||
              data?.ResponseDescription ||
              "STK push failed",

            details:
              data
          });
      }

      const order = {
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

        adminWhatsappSent:
          false,

        emailSent:
          false,

        paymentConfirmedAt:
          null,

        paymentConfirmationMethod:
          null,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      };

      const orders =
        readOrders();

      orders.push(
        order
      );

      if (
        !writeOrders(
          orders
        )
      ) {
        console.error(
          "⚠️ STK accepted but order could not be persisted",
          orderId
        );
      }

      return res.json({
        success:
          true,

        orderId,

        checkoutRequestId:
          order.checkoutRequestId,

        merchantRequestId:
          order.merchantRequestId,

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

/* =========================================================
   M-PESA PAYMENT STATUS / QUERY
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
            "CheckoutRequestID is required"
        });
    }

    try {
      let order =
        readOrders().find(
          (o) =>
            o.checkoutRequestId ===
            checkoutRequestId
        );

      if (
        order &&
        String(
          order.status
        ).toUpperCase() ===
        "PAID"
      ) {
        return res.json(
          paymentResponse(
            order
          )
        );
      }

      if (
        order &&
        String(
          order.status
        ).toUpperCase() ===
        "FAILED"
      ) {
        return res.json(
          paymentResponse(
            order
          )
        );
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
        mpesaPassword(
          shortcode,
          passkey,
          timestamp
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

      /*
        A failed query request does NOT mean
        the customer's payment failed.
      */

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
        RESULT CODE 0 = PAYMENT SUCCESSFUL
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
        A non-zero query result is NOT used here to
        overwrite an order as FAILED.

        The Safaricom callback is allowed to provide
        the final transaction result. This prevents
        a temporary/early STK query result from making
        the website show "payment not completed" while
        the callback is still being processed.
      */

      if (
        Number.isFinite(
          resultCode
        )
      ) {
        const latestOrder =
          readOrders().find(
            (o) =>
              o.checkoutRequestId ===
              checkoutRequestId
          ) || order;

        /*
          If the callback already confirmed PAID,
          PAID always wins.
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
          Keep the transaction pending and wait for
          the callback to determine the final result.
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
        No result code yet.
      */

      return res.json({
        success:
          true,

        status:
          "PENDING",

        orderId:
          order?.orderId ||
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
);/* =========================================================
   M-PESA CALLBACK
   ========================================================= */

async function handleMpesaCallback(
  req,
  res
) {
  console.log(
    "📥 M-PESA CALLBACK RECEIVED:",
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
        "⚠️ Callback missing Body.stkCallback"
      );

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

    console.log(
      "📥 M-PESA CALLBACK SUMMARY:",
      {
        checkoutRequestId,
        resultCode,
        resultDesc
      }
    );

    if (!checkoutRequestId) {
      console.error(
        "⚠️ Callback has no CheckoutRequestID"
      );

      return res.json({
        ResultCode:
          0,

        ResultDesc:
          "Accepted"
      });
    }

    const orders =
      readOrders();

    const idx =
      orders.findIndex(
        (o) =>
          o.checkoutRequestId ===
          checkoutRequestId
      );

    if (idx < 0) {
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
      Number.isFinite(
        resultCode
      )
        ? resultCode
        : null;

    order.resultDesc =
      resultDesc;

    order.updatedAt =
      new Date().toISOString();

    /*
      SUCCESSFUL PAYMENT

      This callback is the authoritative
      confirmation from Safaricom.
    */

    if (
      resultCode ===
      0
    ) {
      const meta =
        extractCallbackMetadata(
          callback
        );

      console.log(
        "✅ M-PESA PAYMENT SUCCESSFUL",
        {
          orderId:
            order.orderId,

          checkoutRequestId,

          amount:
            meta.amount,

          receipt:
            meta.receiptNumber,

          phone:
            meta.phoneNumber,

          transactionDate:
            meta.transactionDate
        }
      );

      await markOrderPaidAndNotify(
        order,

        meta.amount ??
          order.paidAmount ??
          order.amount ??
          null,

        meta.receiptNumber ||
          order.mpesaReceiptNumber ||
          null,

        resultDesc ||
          "Payment completed",

        {
          method:
            "callback",

          transactionDate:
            meta.transactionDate,

          paidPhone:
            meta.phoneNumber
        }
      );

      /*
        Persist all fields from the
        successful Safaricom callback.
      */

      const latest =
        readOrders();

      const latestIdx =
        latest.findIndex(
          (o) =>
            o.orderId ===
            order.orderId
        );

      if (
        latestIdx >=
        0
      ) {
        latest[latestIdx] = {
          ...latest[
            latestIdx
          ],

          checkoutRequestId,

          transactionDate:
            meta.transactionDate ??
            latest[
              latestIdx
            ].transactionDate ??
            null,

          paidPhone:
            meta.phoneNumber ??
            latest[
              latestIdx
            ].paidPhone ??
            null,

          paidAmount:
            meta.amount ??
            latest[
              latestIdx
            ].paidAmount ??
            latest[
              latestIdx
            ].amount ??
            null,

          mpesaReceiptNumber:
            meta.receiptNumber ||
            latest[
              latestIdx
            ].mpesaReceiptNumber ||
            null,

          resultCode:
            0,

          resultDesc:
            resultDesc ||
            "Payment completed",

          status:
            "PAID",

          updatedAt:
            new Date().toISOString()
        };

        writeOrders(
          latest
        );
      }
    } else {
      /*
        Safaricom callback returned
        a non-zero result code.
      */

      markOrderFailed(
        order,
        resultCode,
        resultDesc
      );

      console.log(
        "❌ PAYMENT FAILED:",
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
    ALWAYS ACKNOWLEDGE SAFARICOM.
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

/*
  GET is only for testing the URL
  in a browser. Safaricom uses POST.
*/

app.get(
  "/api/mpesa/callback",
  (_req, res) => {
    res.json({
      ok:
        true,

      endpoint:
        "M-PESA callback",

      methodExpectedFromSafaricom:
        "POST",

      time:
        new Date().toISOString()
    });
  }
);

/* =========================================================
   ROOT / HEALTH
   ========================================================= */

app.get(
  "/",
  (_req, res) => {
    res.json({
      ok:
        true,

      service:
        "ananda-green-herbary",

      environment:
        MPESA_ENV,

      mpesaBase:
        MPESA_BASE,

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

      mpesaCallbackUrl:
        process.env.MPESA_CALLBACK_URL ||
        null,

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

/* =========================================================
   ORDERS
   ========================================================= */

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
      readOrders().find(
        (o) =>
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

/* =========================================================
   SIMPLE ORDER STATUS
   ========================================================= */

app.get(
  "/api/orders/:orderId/status",
  (req, res) => {
    const order =
      readOrders().find(
        (o) =>
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

      resultCode:
        order.resultCode ??
        null,

      resultDesc:
        order.resultDesc ||
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
        null,

      paymentConfirmedAt:
        order.paymentConfirmedAt ||
        null,

      paymentConfirmationMethod:
        order.paymentConfirmationMethod ||
        null
    });
  }
);

/* =========================================================
   WHATSAPP TEST
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
            "Use /test-whatsapp?phone=2547XXXXXXXX or set ADMIN_NOTIFY_PHONE"
        });
    }

    return res.json(
      await sendWhatsAppMessage({
        phone,

        orderId:
          "TEST-001",

        amount:
          10,

        receipt:
          "TESTRECEIPT"
      })
    );
  }
);

/* =========================================================
   EMAIL TEST
   ========================================================= */

app.get(
  "/test-email",
  async (_req, res) => {
    const result =
      await sendPaidOrderEmail({
        orderId:
          "TEST-EMAIL-001",

        status:
          "PAID",

        paidAmount:
          10,

        mpesaReceiptNumber:
          "TESTRECEIPT",

        customerName:
          "Test Customer",

        customerPhone:
          "254700000000",

        email:
          "test@example.com",

        address:
          "Test address",

        city:
          "Nairobi",

        items: [
          {
            name:
              "Test Product",

            quantity:
              1,

            price:
              10
          }
        ],

        notes:
          "Email configuration test",

        paymentConfirmedAt:
          new Date().toISOString()
      });

    return res.json(
      result
    );
  }
);

/* =========================================================
   404
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
   START SERVER
   ========================================================= */

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
      `   M-Pesa base      : ${MPESA_BASE}`
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

MPESA_ENV is fixed to sandbox
MPESA_CONSUMER_KEY=...
MPESA_CONSUMER_SECRET=...
MPESA_SHORTCODE=...
MPESA_PASSKEY=...
MPESA_CALLBACK_URL=https://YOUR-ACTUAL-NODE-SERVER/api/mpesa/callback

WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_TEMPLATE_NAME=...
WHATSAPP_TEMPLATE_LANG=en
WHATSAPP_API_VERSION=v24.0

ADMIN_NOTIFY_PHONE=2547XXXXXXXX

# Africa's Talking SMS
AT_USERNAME=your_africastalking_username
AT_API_KEY=your_africastalking_api_key
# Approved Sender ID. Use the exact ID registered with Africa's Talking.
# "ANANDA Green Herbary" is too long for Kenya's 11-character Sender ID limit.
AT_SENDER_ID=ANANDA

EMAIL_ENABLED=true
ADMIN_NOTIFY_EMAIL=anandagreenherbary@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=anandagreenherbary@gmail.com
SMTP_PASS=YOUR_GMAIL_APP_PASSWORD
EMAIL_FROM=anandagreenherbary@gmail.com
*/
