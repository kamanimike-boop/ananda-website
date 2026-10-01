/* =========================================================
   M-PESA CALLBACK
   ========================================================= */

/*
 * IMPORTANT:
 *
 * Safaricom callback URL:
 *
 * https://www.anandagreenherbary.co.ke/api/mpesa/callback
 *
 * This route is intentionally available at /api/mpesa/callback
 * so it matches the MPESA_CALLBACK_URL environment variable.
 *
 * /api/payment/callback is also supported below.
 */

async function handleMpesaCallback(req, res) {

  console.log("");
  console.log("======================================");
  console.log("M-PESA SANDBOX CALLBACK RECEIVED");
  console.log("======================================");

  console.log(
    JSON.stringify(req.body, null, 2)
  );

  try {

    const callback =
      req.body?.Body?.stkCallback;

    /*
     * If Safaricom sends an unexpected callback,
     * acknowledge it so Safaricom does not keep retrying.
     */

    if (!callback) {

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });

    }

    const merchantRequestId =
      callback.MerchantRequestID || null;

    const checkoutRequestId =
      callback.CheckoutRequestID || null;

    const resultCode =
      Number(callback.ResultCode);

    const resultDesc =
      callback.ResultDesc || "";

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
       CALLBACK METADATA
       ----------------------------------------- */

    let receiptNumber = null;
    let transactionDate = null;
    let phoneNumber = null;
    let amount = null;

    const metadata =
      callback.CallbackMetadata?.Item;

    if (Array.isArray(metadata)) {

      for (const item of metadata) {

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


    if (orderIndex === -1) {

      console.error(
        "⚠️ No matching order for callback:",
        checkoutRequestId
      );

      /*
       * Still acknowledge Safaricom.
       */

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted"
      });

    }


    const order =
      orders[orderIndex];


    order.resultCode =
      resultCode;

    order.resultDesc =
      resultDesc;

    order.updatedAt =
      new Date().toISOString();


    /* -----------------------------------------
       PAYMENT SUCCESS
       ----------------------------------------- */

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


      /*
       * Save PAID order before sending
       * WhatsApp notification.
       */

      writeOrders(orders);


      /* ---------------------------------------
         WHATSAPP ORDER NOTIFICATION
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

      writeOrders(orders);


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
   * ALWAYS acknowledge Safaricom.
   */

  return res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });

}


/* =========================================================
   CALLBACK ROUTES
   ========================================================= */

/*
 * PRIMARY CALLBACK
 *
 * This MUST match:
 *
 * https://www.anandagreenherbary.co.ke/api/mpesa/callback
 */

app.post(
  "/api/mpesa/callback",
  handleMpesaCallback
);


/*
 * SECONDARY CALLBACK
 *
 * Kept for compatibility with the previous
 * /api/payment/callback configuration.
 */

app.post(
  "/api/payment/callback",
  handleMpesaCallback
);
