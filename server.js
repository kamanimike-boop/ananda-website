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
    text: `ANANDA GREEN HERBARY — NEW MANUAL TILL ORDER\n\n${common}\n\nPayment code is customer-supplied and has not been independently verified.`
  });

  if (order.email) {
    const requiredMessage = "Thank you for trusting us support your health naturally Ananda green herbary will deliver your product within 24hrs -48hrs. You will also receive free consultation through whatup and call. Healing for a better life";
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || user,
      to: order.email,
      subject: `Ananda Green Herbary — Order ${order.orderId} received`,
      text: `${requiredMessage}\n\nYour order summary:\n${lines}\n\nDelivery fee: ${money(order.deliveryFee)}\nTotal submitted: ${money(order.totalAmount)}\nOrder ID: ${order.orderId}\n\nYour order is submitted; the M-Pesa code is subject to manual payment verification.`
    });
  }

  return { adminSent: true, customerSent: Boolean(order.email) };
}

app.post("/api/orders/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const { name, phone, address, city, email, orderCode, items } = body;
    const deliveryFee = Number(body.deliveryFee);
    const totalAmount = Number(body.totalAmount);

    if (![name, phone, address, city, orderCode].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({ success: false, message: "Name, phone, address, city and M-Pesa confirmation code are required." });
    }

    const cleanOrderCode = String(orderCode).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(cleanOrderCode)) {
      return res.status(400).json({ success: false, message: "Please enter a valid M-Pesa confirmation code from your Safaricom SMS." });
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
      orderCode: cleanOrderCode,
      items: cleanItems,
      subtotal: Math.round(subtotal * 100) / 100,
      deliveryFee: Math.round(deliveryFee * 100) / 100,
      totalAmount: Math.round(totalAmount * 100) / 100,
      status: "SUBMITTED",
      paymentMethod: "Manual M-Pesa Till / Buy Goods",
      tillNumber: "5475967",
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
      message: "Your order has been submitted. We will verify the M-Pesa payment manually.",
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
