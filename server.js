"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORDERS_FILE = path.join(__dirname, "orders.json");
const ADMIN_EMAIL = "anandagreenherbary@gmail.com";
const MPESA_TILL = "5475967";

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

function cleanEnv(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function getEmailConfig() {
  const host = cleanEnv(process.env.SMTP_HOST) || "smtp.gmail.com";
  const port = Number(cleanEnv(process.env.SMTP_PORT) || 465);
  const secureValue = cleanEnv(process.env.SMTP_SECURE);
  const secure = secureValue
    ? ["true", "1", "yes"].includes(secureValue.toLowerCase())
    : port === 465;
  const user = cleanEnv(process.env.SMTP_USER) || ADMIN_EMAIL;

  // Google shows App Passwords in groups of four characters.
  // Spaces are formatting only, so remove them before authenticating.
  const pass = cleanEnv(process.env.SMTP_PASS).replace(/\s+/g, "");

  const emailFrom = cleanEnv(process.env.EMAIL_FROM) || user;
  const enabledValue = cleanEnv(process.env.EMAIL_ENABLED).toLowerCase();
  const enabled = enabledValue === "" || ["true", "1", "yes"].includes(enabledValue);

  return { host, port, secure, user, pass, emailFrom, enabled };
}

function getEmailTransporter() {
  const config = getEmailConfig();

  if (!config.enabled) {
    throw new Error("EMAIL_ENABLED is false");
  }
  if (!config.user) {
    throw new Error("SMTP_USER is not configured");
  }
  if (!config.pass) {
    throw new Error("SMTP_PASS is not configured");
  }
  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error("SMTP_PORT is invalid");
  }

  const transportConfig = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  };

  return nodemailer.createTransport(transportConfig);
}

async function verifyEmailTransport() {
  const config = getEmailConfig();
  console.log(
    `Email config: enabled=${config.enabled} host=${config.host} port=${config.port} secure=${config.secure} user=${config.user} passwordPresent=${Boolean(config.pass)} from=${config.emailFrom}`
  );

  if (!config.enabled) {
    console.log("Email notifications are disabled by EMAIL_ENABLED.");
    return false;
  }

  if (!config.pass) {
    console.error("EMAIL ERROR: SMTP_PASS is missing.");
    return false;
  }

  try {
    const transporter = getEmailTransporter();
    await transporter.verify();
    console.log("EMAIL SMTP VERIFY: SUCCESS");
    return true;
  } catch (err) {
    console.error(`EMAIL SMTP VERIFY: FAILED — ${err.message}`);
    return false;
  }
}

async function sendOneOrderEmail(transporter, message, label) {
  try {
    const info = await transporter.sendMail(message);
    console.log(`EMAIL ${label}: SENT messageId=${info.messageId}`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error(`EMAIL ${label}: FAILED — ${err.message}`);
    return { sent: false, error: err.message };
  }
}

async function sendOrderEmails(order) {
  const config = getEmailConfig();

  if (!config.enabled) {
    return {
      adminSent: false,
      customerSent: false,
      error: "EMAIL_ENABLED is false"
    };
  }

  let transporter;
  try {
    transporter = getEmailTransporter();
  } catch (err) {
    return {
      adminSent: false,
      customerSent: false,
      error: err.message
    };
  }

  const lines = itemLines(order.items);
  const common = [
    `Order ID: ${order.orderId}`,
    `Status: ${order.status}`,
    `Customer: ${order.name}`,
    `Phone: ${order.phone}`,
    `Email: ${order.email || "Not provided"}`,
    `Address: ${order.address}, ${order.city}`,
    `M-Pesa confirmation code: ${order.orderCode}`,
    `M-Pesa Till: ${MPESA_TILL}`,
    `Subtotal: ${money(order.subtotal)}`,
    `Delivery fee: ${money(order.deliveryFee)}`,
    `Total submitted: ${money(order.totalAmount)}`,
    "",
    "Items:",
    lines
  ].join("\n");

  // Send both messages independently. A failure of one must not stop the other.
  const adminResult = await sendOneOrderEmail(
    transporter,
    {
      from: config.emailFrom,
      to: ADMIN_EMAIL,
      replyTo: order.email || undefined,
      subject: `ANANDA ORDER SUBMITTED — ${order.orderId}`,
      text: `ANANDA GREEN HERBARY — NEW MANUAL TILL ORDER\n\n${common}\n\nPayment code is customer-supplied and has not been independently verified.`
    },
    "ADMIN"
  );

  let customerResult = { sent: false, skipped: true };

  if (order.email) {
    const requiredMessage =
      "Thank you for trusting us to support your health naturally. Ananda Green Herbary will deliver your product within 24hrs - 48hrs. You will also receive free consultation through WhatsApp and call. Healing for a better life.";

    customerResult = await sendOneOrderEmail(
      transporter,
      {
        from: config.emailFrom,
        to: order.email,
        subject: `Ananda Green Herbary — Order ${order.orderId} received`,
        text: `${requiredMessage}\n\nYour order summary:\n${lines}\n\nDelivery fee: ${money(order.deliveryFee)}\nTotal submitted: ${money(order.totalAmount)}\nOrder ID: ${order.orderId}\n\nYour order is submitted; the M-Pesa code is subject to manual payment verification.`
      },
      "CUSTOMER"
    );
  }

  const errors = [];
  if (!adminResult.sent && adminResult.error) errors.push(`Admin: ${adminResult.error}`);
  if (!customerResult.sent && !customerResult.skipped && customerResult.error) errors.push(`Customer: ${customerResult.error}`);

  return {
    adminSent: adminResult.sent,
    customerSent: Boolean(order.email) && customerResult.sent,
    adminError: adminResult.error || null,
    customerError: customerResult.error || null,
    error: errors.length ? errors.join(" | ") : null
  };
}

app.post("/api/orders/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const { name, phone, address, city, email, orderCode, items } = body;
    const deliveryFee = Number(body.deliveryFee);
    const totalAmount = Number(body.totalAmount);

    if (![name, phone, address, city, orderCode].every(v => typeof v === "string" && v.trim())) {
      return res.status(400).json({
        success: false,
        message: "Name, phone, address, city and M-Pesa confirmation code are required."
      });
    }

    const cleanOrderCode = String(orderCode).trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(cleanOrderCode)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid M-Pesa confirmation code from your Safaricom SMS."
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Your cart is empty." });
    }

    if (!Number.isFinite(deliveryFee) || deliveryFee < 0 || !Number.isFinite(totalAmount) || totalAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid delivery fee or total amount." });
    }

    const cleanEmail = email ? String(email).trim() : "";
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
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
      email: cleanEmail,
      orderCode: cleanOrderCode,
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

    const emailResult = await sendOrderEmails(order);
    order.emailNotifications = emailResult;

    if (emailResult.adminSent || emailResult.customerSent) {
      order.emailSentAt = new Date().toISOString();
    }
    if (emailResult.error) {
      order.emailError = emailResult.error;
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
      message: emailResult.adminSent || emailResult.customerSent
        ? "Your order has been submitted. We will verify the M-Pesa payment manually."
        : "Your order has been submitted, but the email notifications could not be sent. We will still process the order.",
      emailNotifications: order.emailNotifications
    });
  } catch (err) {
    console.error("Order submission error:", err);
    return res.status(500).json({
      success: false,
      message: "Unable to submit order right now. Please try again or contact Ananda."
    });
  }
});

app.get("/health", (_req, res) => {
  const config = getEmailConfig();
  res.json({
    ok: true,
    service: "ananda-green-herbary",
    time: new Date().toISOString(),
    email: {
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      passwordPresent: Boolean(config.pass),
      from: config.emailFrom
    }
  });
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.use(express.static(__dirname));

app.get("/api/orders", (_req, res) => res.json(readOrders()));

app.use((err, _req, res, _next) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ success: false, message: "Server error" });
});

app.listen(PORT, () => {
  console.log(`Ananda manual Till order server listening on port ${PORT}`);
  // Verify SMTP after the web server starts. Never log the password itself.
  verifyEmailTransport().catch(err => console.error("Email startup check error:", err.message));
});

// Truehost / cPanel environment variables required:
// SMTP_HOST=smtp.gmail.com
// SMTP_PORT=465
// SMTP_SECURE=true
// SMTP_USER=anandagreenherbary@gmail.com
// SMTP_PASS=YOUR_GMAIL_APP_PASSWORD   (remove spaces)
// EMAIL_FROM=anandagreenherbary@gmail.com
// EMAIL_ENABLED=true
