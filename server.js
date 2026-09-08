const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

/* =========================================================
   BASIC EXPRESS SETUP
========================================================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Serve the ANANDA website */
app.use(express.static(__dirname));


/* =========================================================
   M-PESA CONFIGURATION
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
  process.env.MPESA_CALLBACK_URL;

/* Daraja Sandbox */
const MPESA_BASE_URL =
  "https://sandbox.safaricom.co.ke";


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
      error
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
      )
    );

  } catch (error) {

    console.error(
      "Could not write orders:",
      error
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
        )

    });

  }
);


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

    if (
      part.type !==
      "literal"
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


  /* 07XXXXXXXX */
  if (
    value.startsWith("07") ||
    value.startsWith("01")
  ) {

    value =
      "254" +
      value.substring(1);

  }


  /* 7XXXXXXXX / 1XXXXXXXX */
  if (
    value.startsWith("7") ||
    value.startsWith("1")
  ) {

    value =
      "254" +
      value;

  }


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
    IMPORTANT:

    Daraja OAuth uses:

    Base64(
      ConsumerKey:ConsumerSecret
    )

    DO NOT SHA-256 HASH THIS.
  */

  const credentials =
    Buffer.from(
      MPESA_CONSUMER_KEY +
      ":" +
      MPESA_CONSUMER_SECRET
    ).toString(
      "base64"
    );


  const response =
    await axios.get(

      MPESA_BASE_URL +
      "/oauth/v1/generate?grant_type=client_credentials",

      {
        headers: {

          Authorization:
            "Basic " +
            credentials

        },

        timeout:
          30000
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
   CREATE STK ACCOUNT REFERENCE
========================================================= */

function createAccountReference(
  orderId
) {

  /*
    Daraja AccountReference has a
    maximum length of 12 characters.

    We therefore send only the first
    12 characters to M-PESA.

    The COMPLETE orderId is still
    stored internally and linked to
    CheckoutRequestID.
  */

  const reference =
    String(
      orderId ||
      "ANANDA"
    );

  return reference.substring(
    0,
    12
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
        "M-PESA STK PUSH REQUEST"
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
      } = req.body;


      console.log(
        "Customer:",
        name
      );

      console.log(
        "Phone received:",
        phone
      );

      console.log(
        "Amount received:",
        amount
      );

      console.log(
        "Order ID:",
        orderId
      );


      /* -----------------------------------------
         CONFIGURATION CHECK
      ----------------------------------------- */

      if (
        !MPESA_SHORTCODE ||
        !MPESA_PASSKEY ||
        !MPESA_CALLBACK_URL
      ) {

        return res.status(500).json({

          success: false,

          error:
            "M-PESA configuration is incomplete"

        });

      }


      /* -----------------------------------------
         ORDER ID CHECK
      ----------------------------------------- */

      if (
        !orderId ||
        !String(orderId).trim()
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Order ID is required"

        });

      }


      const cleanOrderId =
        String(orderId).trim();


      /* -----------------------------------------
         PHONE CHECK
      ----------------------------------------- */

      const normalizedPhone =
        normalizePhone(phone);


      if (!normalizedPhone) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid Kenyan phone number"

        });

      }


      /* -----------------------------------------
         AMOUNT CHECK
      ----------------------------------------- */

      const numericAmount =
        Number(amount);


      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount <= 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Invalid payment amount"

        });

      }


      const finalAmount =
        Math.round(
          numericAmount
        );


      if (finalAmount <= 0) {

        return res.status(400).json({

          success: false,

          error:
            "Payment amount must be greater than zero"

        });

      }


      /* -----------------------------------------
         GET ACCESS TOKEN
      ----------------------------------------- */

      console.log(
        "Requesting M-PESA access token..."
      );


      const accessToken =
        await getAccessToken();


      console.log(
        "Access token received."
      );


      /* -----------------------------------------
         TIMESTAMP
      ----------------------------------------- */

      const timestamp =
        getKenyaTimestamp();


      console.log(
        "Timestamp:",
        timestamp
      );


      /* -----------------------------------------
         DARaja PASSWORD
      ----------------------------------------- */

      /*
        Correct formula:

        Base64(
          Shortcode +
          Passkey +
          Timestamp
        )

        DO NOT SHA-256 HASH.
      */

      const password =
        Buffer.from(

          MPESA_SHORTCODE +
          MPESA_PASSKEY +
          timestamp

        ).toString(
          "base64"
        );


      /* -----------------------------------------
         ACCOUNT REFERENCE
      ----------------------------------------- */

      const reference =
        createAccountReference(
          accountReference ||
          cleanOrderId
        );


      const description =
        String(
          transactionDesc ||
          "ANANDA Herbal Products"
        ).substring(
          0,
          20
        );


      /* -----------------------------------------
         STK PAYLOAD
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


      console.log("");
      console.log(
        "STK REQUEST DETAILS"
      );

      console.log(
        "-----------------------------"
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
        "TransactionType:",
        "CustomerPayBillOnline"
      );

      console.log(
        "Callback:",
        MPESA_CALLBACK_URL
      );

      console.log(
        "Full Order ID:",
        cleanOrderId
      );

      console.log(
        "AccountReference:",
        reference
      );

      console.log(
        "TransactionDesc:",
        description
      );

      console.log(
        "-----------------------------"
      );


      /* -----------------------------------------
         SEND STK PUSH
      ----------------------------------------- */

      const response =
        await axios.post(

          MPESA_BASE_URL +
          "/mpesa/stkpush/v1/processrequest",

          payload,

          {
            headers: {

              Authorization:
                "Bearer " +
                accessToken,

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
        "-----------------------------"
      );

      console.log(
        JSON.stringify(
          response.data,
          null,
          2
        )
      );

      console.log(
        "-----------------------------"
      );


      /* -----------------------------------------
         RESPONSE IDS
      ----------------------------------------- */

      const checkoutRequestId =
        response.data &&
        response.data.CheckoutRequestID;


      const merchantRequestId =
        response.data &&
        response.data.MerchantRequestID;


      const responseCode =
        response.data &&
        response.data.ResponseCode;


      /* -----------------------------------------
         VERIFY DARaja ACCEPTED REQUEST
      ----------------------------------------- */

      if (
        String(
          responseCode
        ) !== "0" ||
        !checkoutRequestId
      ) {

        return res.status(400).json({

          success: false,

          error:
            response.data?.ResponseDescription ||
            response.data?.errorMessage ||
            "M-PESA STK Push was not accepted",

          responseCode:
            responseCode || null

        });

      }


      /* -----------------------------------------
         SAVE PENDING ORDER
      ----------------------------------------- */

      const orders =
        readOrders();


      const now =
        new Date().toISOString();


      /*
        Prevent duplicate order records
        if the same orderId is accidentally
        submitted twice.
      */

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
          merchantRequestId || null,

        checkoutRequestId:
          checkoutRequestId || null,

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
          existingIndex !== -1 &&
          orders[existingIndex].createdAt
            ? orders[existingIndex].createdAt
            : now,

        updatedAt:
          now

      };


      if (
        existingIndex !== -1
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


      console.log("");
      console.log(
        "PENDING ORDER SAVED"
      );

      console.log(
        "Order ID:",
        cleanOrderId
      );

      console.log(
        "CheckoutRequestID:",
        checkoutRequestId
      );

      console.log(
        "Amount:",
        finalAmount
      );

      console.log(
        "Status:",
        "PENDING"
      );

      console.log(
        "================================="
      );


      /* -----------------------------------------
         RETURN TO WEBSITE
      ----------------------------------------- */

      return res.json({

        success: true,

        message:
          response.data.CustomerMessage ||
          "STK Push sent successfully",

        customerMessage:
          response.data.CustomerMessage ||
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
          response.data.ResponseDescription ||
          ""

      });


    } catch (error) {

      console.error("");
      console.error(
        "================================="
      );

      console.error(
        "STK PUSH ERROR"
      );

      console.error(
        "================================="
      );


      if (error.response) {

        console.error(
          "M-PESA HTTP STATUS:",
          error.response.status
        );

        console.error(
          "M-PESA RESPONSE:",
          error.response.data
        );


        return res.status(
          error.response.status ||
          500
        ).json({

          success: false,

          error:
            error.response.data?.errorMessage ||
            error.response.data?.ResponseDescription ||
            "M-PESA STK Push failed"

        });

      }


      console.error(
        "Error:",
        error.message
      );


      return res.status(
        500
      ).json({

        success: false,

        error:
          error.message ||
          "M-PESA STK Push failed"

      });

    }

  }
);


/* =========================================================
   M-PESA CALLBACK
========================================================= */

app.post(
  "/api/mpesa/callback",
  (req, res) => {

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


      /* -----------------------------------------
         INVALID CALLBACK
      ----------------------------------------- */

      if (!callback) {

        console.log(
          "No stkCallback found."
        );


        return res.json({

          ResultCode:
            0,

          ResultDesc:
            "Accepted"

        });

      }


      /* -----------------------------------------
         BASIC CALLBACK DATA
      ----------------------------------------- */

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


      /* -----------------------------------------
         EXTRACT CALLBACK METADATA
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
        Array.isArray(
          metadata
        )
      ) {

        for (
          const item
          of metadata
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

        console.log("");
        console.log(
          "================================="
        );

        console.log(
          "WARNING: NO MATCHING ORDER"
        );

        console.log(
          "================================="
        );

        console.log(
          "CheckoutRequestID:",
          checkoutRequestId
        );

        console.log(
          "MerchantRequestID:",
          merchantRequestId
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
          "This callback did not originate from a saved ANANDA order."
        );

        console.log(
          "================================="
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


      /* -----------------------------------------
         ORDER FOUND
      ----------------------------------------- */

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
          "CheckoutRequestID:",
          checkoutRequestId
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

        console.log(
          "Transaction Date:",
          transactionDate
        );

        console.log(
          "Status:",
          "PAID"
        );

        console.log(
          "================================="
        );


      } else {

        /* ---------------------------------------
           PAYMENT FAILED / CANCELLED / TIMEOUT
        --------------------------------------- */

        order.status =
          "FAILED";


        console.log("");
        console.log(
          "================================="
        );

        console.log(
          "PAYMENT FAILED / CANCELLED"
        );

        console.log(
          "================================="
        );

        console.log(
          "Order ID:",
          order.orderId
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


        if (
          resultCode === 1032
        ) {

          console.log(
            "Reason: Request cancelled by user."
          );

        }


        if (
          resultCode === 1037
        ) {

          console.log(
            "Reason: STK request timed out because the user/device could not be reached."
          );

        }


        if (
          resultCode === 1
        ) {

          console.log(
            "Reason: Insufficient balance."
          );

        }


        console.log(
          "Status:",
          "FAILED"
        );

        console.log(
          "================================="
        );

      }


      /* -----------------------------------------
         SAVE UPDATED ORDER
      ----------------------------------------- */

      writeOrders(
        orders
      );


    } catch (error) {

      console.error("");
      console.error(
        "Callback processing error:"
      );

      console.error(
        error
      );

    }


    /* -----------------------------------------
       ALWAYS ACKNOWLEDGE SAFARICOM
    ----------------------------------------- */

    return res.json({

      ResultCode:
        0,

      ResultDesc:
        "Accepted"

    });

  }
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


      if (
        !checkoutRequestId
      ) {

        return res.status(
          400
        ).json({

          success: false,

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

          success: false,

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
        error
      );


      return res.status(
        500
      ).json({

        success: false,

        error:
          "Could not check payment status"

      });

    }

  }
);


/* =========================================================
   GET ONE ORDER BY ORDER ID
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

          item =>
            item.orderId ===
            orderId

        );


      if (!order) {

        return res.status(
          404
        ).json({

          success: false,

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
        error
      );


      return res.status(
        500
      ).json({

        success: false,

        error:
          "Could not load order"

      });

    }

  }
);


/* =========================================================
   VIEW ALL ORDERS
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
        error
      );


      return res.status(
        500
      ).json({

        success: false,

        error:
          "Could not load orders"

      });

    }

  }
);


/* =========================================================
   FRONTEND FALLBACK
   EXPRESS 5 COMPATIBLE
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
      Boolean(

        MPESA_CONSUMER_KEY &&
        MPESA_CONSUMER_SECRET &&
        MPESA_SHORTCODE &&
        MPESA_PASSKEY &&
        MPESA_CALLBACK_URL

      )
    );

    console.log(
      "Callback URL:",
      MPESA_CALLBACK_URL
    );

    console.log(
      "Sandbox:",
      MPESA_BASE_URL
    );

    console.log(
      "================================="
    );

  }
);
