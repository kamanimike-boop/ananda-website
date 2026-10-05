"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORDERS_FILE = path.join(__dirname, "orders.json");
const ADMIN_EMAIL = "anandagreenherbary@gmail.com";

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Could not read orders.json:", err.message);
    return [];
  }
}

function writeOrders(orders) {
  const temp = `${ORDERS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(orders, null, 2), "utf8");
  fs.renameSync(temp, ORDERS_FILE);
}

function money(value) {
  return `KES ${Number(value || 0).toLocaleString("en-KE")}`;
}

function itemLines(items) {
  return items.map((item, index) =>
    `${index + 1}. ${String(item.name || "Item")} × ${Number(item.quantity || 1)} — ${money(item.price)}`
  ).join("\n");
}

async function sendOrderEmails(order) {
  if (String(process.env.EMAIL_ENABLED || "true").toLowerCase() !== "true") {
    return { adminSent: false, customerSent: false, reason: "Email disabled" };
  }

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || (port === 465)).toLowerCase() === "true";
  const user = process.env.SMTP_USER || ADMIN_EMAIL;

  // Set SMTP_PASS to your Gmail App Password in the hosting environment.
  const pass = process.env.SMTP_PASS;
  if (!pass) throw new Error("SMTP_PASS is not configured");

  const transporter = nodemailer.createTransport({
    host, port, secure, auth: { user, pass }
  });

  const lines = itemLines(order.items);
  const common = [
    `Order ID: ${order.orderId}`,
    `Status: ${order.status}`,
    `Customer: ${order.name}`,
    `Phone: ${order.phone}`,
    `Email: ${order.email || "Not provided"}`,
    `Address: ${order.address}, ${order.city}`,
    `M-Pesa confirmation code: ${order.orderCode}`,
    `Subtotal: ${money(order.subtotal)}`,
    `Delivery fee: ${money(order.deliveryFee)}`,
    `Total submitted: ${money(order.totalAmount)}`,
    "",
    "Items:",
    lines
  ].join("\n");

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || user,
    to: ADMIN_EMAIL,
    subject: `ANANDA ORDER SUBMITTED — ${order.orderId}`,
    text: order.status === "PAID"
      ? `ANANDA GREEN HERBARY — PAYMENT CONFIRMED\n\n${common}\n\nPayment was confirmed automatically by Safaricom C2B for Till ${MPESA_TILL}.`
      : `ANANDA GREEN HERBARY — NEW MANUAL TILL ORDER\n\n${common}\n\nPayment code is customer-supplied and has not been independently verified.`
  });

  if (order.email) {
    const requiredMessage = "Thank you for trusting us support your health naturally Ananda green herbary will deliver your product within 24hrs -48hrs. You will also receive free consultation through whatup and call. Healing for a better life";
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || user,
      to: order.email,
      subject: `Ananda Green Herbary — Order ${order.orderId} received`,
      text: `${requiredMessage}\n\nYour order summary:\n${lines}\n\nDelivery fee: ${money(order.deliveryFee)}\nTotal submitted: ${money(order.totalAmount)}\nOrder ID: ${order.orderId}\n\n${order.status === "PAID" ? `Payment confirmed automatically by Safaricom for Till ${MPESA_TILL}. M-PESA receipt: ${order.mpesaReceiptNumber || order.orderCode || "Verified"}.` : "Your order is submitted; the M-Pesa code is subject to payment verification."}`
    });
  }

  return { adminSent: true, customerSent: Boolean(order.email) };
}


const MPESA_TILL = String(process.env.MPESA_TILL || "5475967").trim();
const PAYMENT_MATCH_WINDOW_MS = Number(process.env.PAYMENT_MATCH_WINDOW_MS || 30 * 60 * 1000);

function saveOrder(order) {
  const orders = readOrders();
  const index = orders.findIndex(o => o.orderId === order.orderId);
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  else orders.push(order);
  writeOrders(orders);
  return order;
}

async function markTillOrderPaid(order, payment) {
  if (!order || order.status === "PAID") return order;

  order.status = "PAID";
  order.paymentVerification = "VERIFIED_BY_SAFARICOM_C2B";
  order.paymentMethod = "M-Pesa Till / Buy Goods — Safaricom C2B";
  order.tillNumber = MPESA_TILL;
  order.mpesaReceiptNumber = payment.transId || order.orderCode || null;
  order.paidAmount = Number(payment.amount || order.totalAmount || 0);
  order.paidPhone = payment.msisdn || null;
  order.paymentTransactionTime = payment.transTime || null;
  order.paymentBusinessShortCode = payment.businessShortCode || null;
  order.paymentConfirmedAt = new Date().toISOString();
  order.updatedAt = new Date().toISOString();

  saveOrder(order);

  try {
    const emailResult = await sendOrderEmails({
      ...order,
      status: "PAID",
      orderCode: order.mpesaReceiptNumber || order.orderCode || "Verified by Safaricom"
    });
    order.emailNotificationsPaid = emailResult;
  } catch (err) {
    console.error("Paid-order email notification failed:", err.message);
    order.emailNotificationsPaid = { adminSent: false, customerSent: false, error: err.message };
  }

  order.updatedAt = new Date().toISOString();
  saveOrder(order);
  return order;
}

/*
 * Safaricom C2B confirmation callback for the live Till.
 * Register this URL in Daraja URL Management:
 * https://www.anandagreenherbary.co.ke/api/payment/confirmation
 *
 * We intentionally do not use /api/mpesa/... here because Safaricom's
 * production URL rules advise avoiding the word "mpesa" in callback URLs.
 */
app.post("/api/payment/confirmation", async (req, res) => {
  const payment = req.body || {};
  console.log("========== SAFARICOM C2B PAYMENT ==========");
  console.log(JSON.stringify(payment, null, 2));

  // Acknowledge Safaricom immediately. The payment is already completed;
  // matching is performed after the callback is accepted.
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const transId = String(payment.TransID || "").trim().toUpperCase();
    const amount = Number(payment.TransAmount);
    const businessShortCode = String(payment.BusinessShortCode || "").trim();
    const transTime = String(payment.TransTime || "").trim();
    const msisdn = String(payment.MSISDN || "").trim();

    if (!transId || !Number.isFinite(amount) || amount <= 0) {
      console.error("C2B callback missing TransID or valid amount.");
      return;
    }

    if (businessShortCode && businessShortCode !== MPESA_TILL) {
      console.error(`C2B callback is for short code ${businessShortCode}, not ANANDA Till ${MPESA_TILL}.`);
      return;
    }

    const orders = readOrders();
    if (orders.some(o => String(o.mpesaReceiptNumber || "").toUpperCase() === transId)) {
      console.log("Duplicate C2B transaction ignored:", transId);
      return;
    }

    const now = Date.now();
    const candidates = orders.filter(order => {
      const created = Date.parse(order.createdAt || "");
      const status = String(order.status || "").toUpperCase();
      const expected = Number(order.totalAmount);
      return (
        ["PENDING_PAYMENT", "SUBMITTED"].includes(status) &&
        Number.isFinite(expected) &&
        Math.round(expected * 100) === Math.round(amount * 100) &&
        Number.isFinite(created) &&
        now - created >= -60000 &&
        now - created <= PAYMENT_MATCH_WINDOW_MS
      );
    });

    if (candidates.length !== 1) {
      console.warn(
        `C2B payment ${transId} was not auto-matched. Amount=${amount}; candidates=${candidates.length}`
      );
      return;
    }

    const paidOrder = await markTillOrderPaid(candidates[0], {
      transId,
      amount,
      businessShortCode,
      transTime,
      msisdn
    });

    console.log("C2B PAYMENT MATCHED AND ORDER MARKED PAID:", paidOrder.orderId);
  } catch (err) {
    console.error("C2B confirmation processing error:", err);
  }
});

/* Check payment status from the website while waiting for the C2B callback. */
app.get("/api/orders/status", (req, res) => {
  const orderId = String(req.query.orderId || "").trim();
  if (!orderId) return res.status(400).json({ success: false, message: "Order ID is required." });

  const order = readOrders().find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });

  return res.json({
    success: true,
    orderId: order.orderId,
    status: order.status,
    paymentVerification: order.paymentVerification || null,
    mpesaReceiptNumber: order.mpesaReceiptNumber || null,
    paidAmount: order.paidAmount ?? null,
    paymentConfirmedAt: order.paymentConfirmedAt || null
  });
});

/* Create the pending order BEFORE the customer pays the Till. */
app.post("/api/orders/create-pending", async (req, res) => {
  try {
    const body = req.body || {};
    const name = body.name;
    const phone = body.phone;
    const address = body.address;
    const city = body.city;
    const email = body.email;
    const items = body.items;
    const deliveryFee = Number(body.deliveryFee);
    const totalAmount = Number(body.totalAmount);

    if (![name, phone, address, city].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({ success: false, message: "Name, phone number, delivery address and city/town are required." });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ success: false, message: "Your cart is empty." });
    }
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || !Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid delivery fee or total amount." });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ success: false, message: "Please provide a valid email address." });
    }

    const cleanItems = items.map(item => ({
      id: String(item.id || ""),
      name: String(item.name || "Item").slice(0, 200),
      quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
      price: Math.max(0, Number(item.price || 0)),
      type: String(item.type || "product")
    }));

    const subtotal = cleanItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = {
      orderId: `ANANDA-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      name: name.trim(), phone: phone.trim(), address: address.trim(), city: city.trim(),
      email: email ? String(email).trim() : "",
      orderCode: "",
      items: cleanItems,
      subtotal: Math.round(subtotal * 100) / 100,
      deliveryFee: Math.round(deliveryFee * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
      status: "PENDING_PAYMENT",
      paymentMethod: "M-Pesa Till / Buy Goods",
      tillNumber: MPESA_TILL,
      paymentVerification: "WAITING_FOR_SAFARICOM_C2B",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      emailNotifications: { adminSent: false, customerSent: false }
    };

    saveOrder(order);
    return res.status(201).json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      tillNumber: MPESA_TILL,
      totalAmount: order.totalAmount,
      message: `Order created. Now pay KES ${order.totalAmount.toLocaleString("en-KE")} to Till ${MPESA_TILL}.`
    });
  } catch (err) {
    console.error("Create pending order error:", err);
    return res.status(500).json({ success: false, message: "Unable to create the order right now." });
  }
});

app.post("/api/orders/submit", async (req, res) => {
  try {
    const body = req.body || {};

    // Manual Till orders may send the customer phone as `phone` or `phoneNumber`,
    // and the M-Pesa receipt code as `orderCode` or `confirmationCode`.
    const name = body.name;
    const phone = typeof body.phone === "string" && body.phone.trim()
      ? body.phone
      : body.phoneNumber;
    const address = body.address;
    const city = body.city;
    const email = body.email;
    const orderCode = typeof body.orderCode === "string" && body.orderCode.trim()
      ? body.orderCode
      : body.confirmationCode;
    const existingOrderId = typeof body.orderId === "string" ? body.orderId.trim() : "";
    const items = body.items;
    const deliveryFee = Number(body.deliveryFee);
    const totalAmount = Number(body.totalAmount);

    if (![name, phone, address, city].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({
        success: false,
        message: "Name, phone number, delivery address, city/town and M-Pesa confirmation code are required."
      });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Your cart is empty." });
    }
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || !Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid delivery fee or total amount." });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ success: false, message: "Please provide a valid email address." });
    }

    /* If the browser created a pending order first, attach the optional receipt code to it. */
    if (existingOrderId) {
      const existingOrders = readOrders();
      const existing = existingOrders.find(o => o.orderId === existingOrderId);
      if (existing) {
        if (orderCode && typeof orderCode === "string") existing.orderCode = orderCode.trim().toUpperCase();
        existing.updatedAt = new Date().toISOString();
        if (existing.status !== "PAID") {
          existing.status = orderCode ? "SUBMITTED" : "PENDING_PAYMENT";
          existing.paymentVerification = orderCode ? "PENDING_MANUAL_REVIEW" : "WAITING_FOR_SAFARICOM_C2B";
        }
        saveOrder(existing);
        return res.status(200).json({
          success: true,
          orderId: existing.orderId,
          status: existing.status,
          message: existing.status === "PAID"
            ? "Payment confirmed. Your order is PAID."
            : "Your order is recorded. We are waiting for Safaricom to confirm the Till payment.",
          paymentVerification: existing.paymentVerification
        });
      }
    }

    if (!orderCode) {
      return res.status(400).json({ success: false, message: "Please enter the M-Pesa confirmation code, or create the pending order first so Safaricom can confirm it automatically." });
    }

    const cleanItems = items.map(item => ({
      id: String(item.id || ""),
      name: String(item.name || "Item").slice(0, 200),
      quantity: Math.max(1, Math.floor(Number(item.quantity || 1))),
      price: Math.max(0, Number(item.price || 0)),
      type: String(item.type || "product")
    }));
    if (cleanItems.some(item => !Number.isFinite(item.price) || !Number.isFinite(item.quantity))) {
      return res.status(400).json({ success: false, message: "Invalid item details." });
    }

    const subtotal = cleanItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const order = {
      orderId: `ANANDA-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      name: name.trim(),
      phone: phone.trim(),
      address: address.trim(),
      city: city.trim(),
      email: email ? String(email).trim() : "",
      orderCode: orderCode.trim().toUpperCase(),
      items: cleanItems,
      subtotal: Math.round(subtotal * 100) / 100,
      deliveryFee: Math.round(deliveryFee * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
      status: "SUBMITTED",
      paymentMethod: "Manual M-Pesa Till / Buy Goods",
      tillNumber: MPESA_TILL,
      paymentVerification: "PENDING_MANUAL_REVIEW",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      emailNotifications: { adminSent: false, customerSent: false }
    };

    const orders = readOrders();
    orders.push(order);
    writeOrders(orders);

    let emailResult;
    try {
      emailResult = await sendOrderEmails(order);
      order.emailNotifications = emailResult;
      order.emailSentAt = new Date().toISOString();
    } catch (emailErr) {
      console.error("Order saved, but email notification failed:", emailErr.message);
      order.emailNotifications = { adminSent: false, customerSent: false, error: emailErr.message };
      order.emailError = emailErr.message;
    }
    order.updatedAt = new Date().toISOString();
    const latest = readOrders();
    const index = latest.findIndex(entry => entry.orderId === order.orderId);
    if (index >= 0) latest[index] = order;
    writeOrders(latest);

    return res.status(201).json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      message: "Your order has been submitted. We will verify the M-Pesa payment manually if Safaricom has not already confirmed it.",
      emailNotifications: order.emailNotifications
    });
  } catch (err) {
    console.error("Order submission error:", err);
    return res.status(500).json({ success: false, message: "Unable to submit order right now. Please try again or contact Ananda." });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "ananda-green-herbary", time: new Date().toISOString() }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(__dirname));

app.get("/api/orders", (_req, res) => res.json(readOrders()));

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ success: false, message: "Server error" });
});

app.listen(PORT, () => console.log(`Ananda manual Till order server listening on port ${PORT}`));

// Required environment variables:
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=465
// SMTP_SECURE=true
// SMTP_USER=anandagreenherbary@gmail.com
// SMTP_PASS=YOUR_GMAIL_APP_PASSWORD  <-- insert Gmail App Password in host environment
// EMAIL_FROM=anandagreenherbary@gmail.com
// EMAIL_ENABLED=true
