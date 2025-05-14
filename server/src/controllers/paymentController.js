import paymentModel from "../models/paymentModel.js";
import {
  createMyPayment,
  getPyamentData,
  getUserPayments,
  getAllPayments,
} from "../services/paymentService.js";
import { pool } from "../config/db.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import { config } from "../config/env.js";

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

export const createRazorpayOrder = async (req, res) => {
  try {
    const {
      amount,
      currency,
      user_id,
      property_id,
      is_deposit,
      is_apartment,
      unit_id,
    } = req.body;

    // Check if this is an apartment booking
    if (is_apartment && unit_id) {
      console.log("Redirecting to apartment order creation endpoint");
      // Import the apartment controller dynamically
      const { createApartmentRazorpayOrder } = await import(
        "../controllers/apartmentController.js"
      );

      // Forward the request to the apartment order handler
      return createApartmentRazorpayOrder(req, res);
    }

    if (!amount || !currency || !user_id || !property_id) {
      return res.status(400).json({
        success: false,
        message: "Amount, currency, user_id, and property_id are required",
      });
    }

    // If it's a deposit payment, include that in the receipt and notes
    const paymentType = is_deposit ? "deposit" : "full";

    const options = {
      amount: Math.round(amount * 100), // Convert to paise
      currency: currency || "INR",
      receipt: `prop_${paymentType}_${user_id}_${property_id}_${Date.now()}`,
      notes: {
        user_id: user_id.toString(),
        property_id: property_id.toString(),
        payment_type: paymentType,
      },
    };

    console.log("Creating Razorpay order with options:", options);

    const order = await razorpay.orders.create(options);
    console.log("Razorpay order created:", order);

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Error creating Razorpay order:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while creating Razorpay order",
      error: error.message,
    });
  }
};

export const verifyRazorpayPayment = async (req, res) => {
  try {
    console.log("Payment verification request received:", req.body);
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
      req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.error("Missing required payment verification parameters");
      return res.status(400).json({
        success: false,
        message: "All payment verification parameters are required",
      });
    }

    // Verify the payment signature
    const generatedSignature = crypto
      .createHmac("sha256", config.razorpay.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    console.log("Signature verification:", {
      provided: razorpay_signature,
      generated: generatedSignature,
      matches: generatedSignature === razorpay_signature,
    });

    if (generatedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment signature. Payment verification failed.",
      });
    }

    // If signature is valid, fetch payment details from Razorpay for double verification
    try {
      const paymentDetails = await razorpay.payments.fetch(razorpay_payment_id);
      console.log("Razorpay payment details:", paymentDetails);

      // Verify that the payment is authorized or captured
      if (
        paymentDetails.status !== "authorized" &&
        paymentDetails.status !== "captured"
      ) {
        return res.status(400).json({
          success: false,
          message: `Payment verification failed. Payment status is ${paymentDetails.status}`,
        });
      }
    } catch (paymentFetchError) {
      console.error(
        "Error fetching payment details from Razorpay:",
        paymentFetchError
      );
      // Continue with verification since signature is valid
    }

    // If signature is valid, return success
    return res.status(200).json({
      success: true,
      message: "Payment verification successful",
    });
  } catch (error) {
    console.error("Error verifying payment:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while verifying payment",
      error: error.message,
    });
  }
};

export const createPayment = async (req, res) => {
  try {
    console.log("Payment request received:", req.body);

    const {
      user_id,
      property_id,
      total_price,
      amount_paid,
      payment_method,
      payment_details,
      status,
      invoice_number,
      is_deposit,
      is_apartment,
      unit_id,
    } = req.body;

    // Check if this is an apartment booking
    if (is_apartment && unit_id) {
      console.log("Redirecting to apartment booking endpoint");
      // Import the apartment controller dynamically
      const { bookApartment } = await import(
        "../controllers/apartmentController.js"
      );

      // Forward the request to the apartment booking handler
      return bookApartment(req, res);
    }

    // Check all required fields
    if (
      !user_id ||
      !property_id ||
      !amount_paid ||
      !payment_method ||
      !payment_details ||
      !status
    ) {
      console.log("Missing required fields", {
        user_id,
        property_id,
        amount_paid,
        payment_method,
        payment_details,
        status,
      });
      return res.status(400).json({
        success: false,
        message: "All payment fields are required",
      });
    }

    // Validate payment method
    const validMethods = ["credit_card", "card", "upi", "razorpay"];
    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid payment method. Accepted methods: credit card, UPI, Razorpay",
      });
    }

    // Validate payment details based on method
    if (payment_method === "credit_card" || payment_method === "card") {
      if (
        !payment_details.card_holder ||
        !payment_details.card_number ||
        !payment_details.expiry_date ||
        !payment_details.cvv
      ) {
        return res.status(400).json({
          success: false,
          message: "All credit card details are required",
        });
      }
    } else if (payment_method === "upi") {
      if (!payment_details.upi_id) {
        return res.status(400).json({
          success: false,
          message: "UPI ID is required for UPI payments",
        });
      }
    } else if (payment_method === "razorpay") {
      if (
        !payment_details.razorpay_payment_id ||
        !payment_details.razorpay_order_id ||
        !payment_details.razorpay_signature
      ) {
        return res.status(400).json({
          success: false,
          message: "All Razorpay payment details are required",
        });
      }

      // Verify Razorpay signature
      const generatedSignature = crypto
        .createHmac("sha256", config.razorpay.keySecret)
        .update(
          `${payment_details.razorpay_order_id}|${payment_details.razorpay_payment_id}`
        )
        .digest("hex");

      if (generatedSignature !== payment_details.razorpay_signature) {
        return res.status(400).json({
          success: false,
          message: "Invalid Razorpay signature",
        });
      }
    }

    // Create standardized payment method name
    const standardizedMethod =
      payment_method === "card" ? "credit_card" : payment_method;

    // Ensure payment_details has all fields initialized to avoid undefined values
    const sanitizedPaymentDetails = {
      card_holder: payment_details.card_holder || null,
      card_number: payment_details.card_number || null,
      expiry_date: payment_details.expiry_date || null,
      cvv: payment_details.cvv || null,
      upi_id: payment_details.upi_id || null,
      razorpay_payment_id: payment_details.razorpay_payment_id || null,
      razorpay_order_id: payment_details.razorpay_order_id || null,
      razorpay_signature: payment_details.razorpay_signature || null,
    };

    // For deposit payments, ensure we have the total price
    let finalTotalPrice = total_price;
    if (is_deposit && !finalTotalPrice) {
      // Try to get the property price from the database
      try {
        const [propertyRows] = await pool.query(
          "SELECT price FROM properties WHERE id = ?",
          [property_id]
        );

        if (propertyRows.length > 0 && propertyRows[0].price) {
          finalTotalPrice = parseFloat(propertyRows[0].price);
          console.log(
            `Retrieved property price for deposit: ${finalTotalPrice}`
          );
        } else {
          console.log(
            "Could not retrieve property price for deposit calculation"
          );
        }
      } catch (priceError) {
        console.error("Error fetching property price:", priceError);
      }
    }

    const newPayment = new paymentModel({
      user_id,
      property_id,
      total_price: finalTotalPrice || null,
      amount_paid,
      payment_method: standardizedMethod,
      payment_details: sanitizedPaymentDetails,
      status,
      payment_date: new Date(),
      invoice_number: invoice_number || null,
      is_deposit: !!is_deposit,
    });

    const result = await createMyPayment(newPayment);
    console.log("Payment creation result:", result);

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("Payment error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while processing payment",
      error: error.message,
    });
  }
};

export const checkPayment = async (req, res) => {
  const { user_id, property_id } = req.query;

  if (!user_id || !property_id) {
    return res.status(400).json({ message: "Missing user_id or property_id" });
  }

  try {
    const paymentData = await getPyamentData(user_id, property_id);
    if (paymentData) {
      return res.status(200).json({ success: true, data: paymentData });
    } else {
      return res
        .status(404)
        .json({ success: false, message: "No payment found" });
    }
  } catch (error) {
    console.error("Error checking payment:", error);
    res.status(500).json({ message: "Server error while checking payment" });
  }
};

// Get all payments for a user
export const getUserPaymentHistory = async (req, res) => {
  const { user_id } = req.params;

  console.log(`Received request for payment history for user_id: ${user_id}`);

  if (!user_id) {
    console.log("Missing user_id in request");
    return res.status(400).json({
      success: false,
      message: "User ID is required",
    });
  }

  try {
    const result = await getUserPayments(user_id);

    console.log(
      `Payment fetch result: success=${result.success}, found ${
        result.payments?.length || 0
      } payments`
    );

    if (result.success && (!result.payments || result.payments.length === 0)) {
      // Successful but empty result
      return res.status(200).json({
        success: true,
        message: "No payments found for this user",
        payments: [],
      });
    }

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error("Error getting payment history:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching payment history",
      error: error.message,
    });
  }
};

// Generate invoice for a payment
export const generateInvoice = async (req, res) => {
  const { payment_id } = req.params;

  if (!payment_id) {
    return res.status(400).json({
      success: false,
      message: "Payment ID is required",
    });
  }

  try {
    console.log(`Generating invoice for payment_id: ${payment_id}`);

    // First check if this is a property payment
    let [propertyPayment] = await pool.query(
      `SELECT p.*, pr.name as property_name, pr.location, 
       CONCAT(u.first_name, ' ', u.last_name) as user_name, u.email,
       'property' as payment_type
       FROM payment p
       LEFT JOIN properties pr ON p.property_id = pr.id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE p.id = ?`,
      [payment_id]
    );

    // If not found in property payments, check apartment payments
    if (!propertyPayment || propertyPayment.length === 0) {
      [propertyPayment] = await pool.query(
        `SELECT 
          p.*, 
          apt.name as property_name, 
          apt.location, 
          CONCAT(u.first_name, ' ', u.last_name) as user_name, 
          u.email,
          'apartment' as payment_type,
          ab.id as booking_id,
          au.unit_number,
          au.floor_number,
          au.bedrooms,
          au.bathrooms,
          au.area
         FROM payments p
         JOIN apartment_bookings ab ON p.id = ab.payment_id
         JOIN apartments apt ON ab.apartment_id = apt.id
         JOIN apartment_units au ON ab.unit_id = au.id
         JOIN users u ON p.user_id = u.id
         WHERE p.id = ?`,
        [payment_id]
      );
    }

    console.log(
      "Payment query result:",
      propertyPayment && propertyPayment.length
        ? "Found payment"
        : "No payment found"
    );

    if (!propertyPayment || propertyPayment.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Payment not found",
      });
    }

    const payment = propertyPayment[0];
    console.log(
      `Payment found, user_id: ${payment.user_id}, property_id: ${payment.property_id}, type: ${payment.payment_type}`
    );

    // Calculate payment statistics differently based on payment type
    let invoiceData = {};

    if (payment.payment_type === "property") {
      try {
        const paymentData = await getPyamentData(
          payment.user_id,
          payment.property_id
        );

        console.log(
          "Payment data result:",
          paymentData ? "Data retrieved" : "No payment data"
        );

        invoiceData = {
          ...payment,
          ...(paymentData?.payment_summary || {
            full_property_price: payment.price || 0,
            deposit_amount: payment.total_price || 0,
            total_paid: payment.amount_paid || 0,
            pending_amount: (payment.price || 0) - (payment.amount_paid || 0),
            percentage_paid:
              payment.price > 0
                ? Math.round((payment.amount_paid / payment.price) * 100)
                : 0,
          }),
        };
      } catch (paymentDataError) {
        console.error("Error in getPyamentData:", paymentDataError);
        throw paymentDataError;
      }
    } else {
      // For apartment bookings
      invoiceData = {
        ...payment,
        full_property_price: payment.total_price || payment.amount_paid || 0,
        deposit_amount: payment.amount_paid || 0,
        total_paid: payment.amount_paid || 0,
        pending_amount: 0, // Assuming full payment for apartments
        percentage_paid: 100, // Assuming full payment for apartments
        unit_details: {
          unit_number: payment.unit_number,
          floor_number: payment.floor_number,
          bedrooms: payment.bedrooms,
          bathrooms: payment.bathrooms,
          area: payment.area,
        },
      };
    }

    return res.status(200).json({
      success: true,
      invoice: invoiceData,
    });
  } catch (error) {
    console.error("Error generating invoice:", error);
    console.error("Stack trace:", error.stack);
    return res.status(500).json({
      success: false,
      message: "Server error while generating invoice",
      error: error.message,
    });
  }
};

export const getAllPaymentsController = async (req, res) => {
  try {
    const result = await getAllPayments();
    if (result.success) {
      return res.status(200).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error) {
    console.error("Error fetching all payments:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// Get all payments for a user (both property and apartment)
export const getAllUserPaymentsController = async (req, res) => {
  const { user_id } = req.params;

  console.log(`Received request for all payments for user_id: ${user_id}`);

  if (!user_id) {
    console.log("Missing user_id in request");
    return res.status(400).json({
      success: false,
      message: "User ID is required",
    });
  }

  try {
    // Get property payments
    const [propertyPayments] = await pool.query(
      `SELECT p.*, pr.name as property_name, pr.location, pr.price, 
        'property' as payment_type
        FROM payment p
        LEFT JOIN properties pr ON p.property_id = pr.id
        WHERE p.user_id = ?`,
      [user_id]
    );

    // Get apartment payments
    const [apartmentPayments] = await pool.query(
      `SELECT 
        p.id, p.user_id, p.property_id, p.total_price, p.amount_paid, 
        p.payment_method, p.payment_details, p.status, p.payment_date, 
        p.invoice_number,
        apt.name as property_name, apt.location, au.price as price,
        'apartment' as payment_type,
        ab.id as booking_id, au.unit_number
        FROM payments p
        JOIN apartment_bookings ab ON p.id = ab.payment_id
        JOIN apartments apt ON ab.apartment_id = apt.id
        JOIN apartment_units au ON ab.unit_id = au.id
        WHERE p.user_id = ?`,
      [user_id]
    );

    // Combine both payment types
    const allPayments = [...propertyPayments, ...apartmentPayments];

    // Sort by payment date, most recent first
    allPayments.sort((a, b) => {
      return new Date(b.payment_date) - new Date(a.payment_date);
    });

    console.log(
      `Found ${allPayments.length} total payments (${propertyPayments.length} property, ${apartmentPayments.length} apartment)`
    );

    return res.status(200).json({
      success: true,
      payments: allPayments,
    });
  } catch (error) {
    console.error("Error getting all user payments:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching payment history",
      error: error.message,
    });
  }
};
