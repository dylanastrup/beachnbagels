const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

// Explicitly set region for Cloud Functions v2
setGlobalOptions({ region: "us-central1" });

// Define Cloud Secrets stored securely in Google Cloud Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

function getStripeClient() {
  const key = stripeSecretKey.value() || process.env.STRIPE_SECRET_KEY;
  return new Stripe(key);
}

/**
 * Creates a Stripe Checkout Session for bagel preorders.
 * Validates drop cutoff time and stock availability server-side.
 */
exports.createCheckoutSession = onRequest({ cors: true, secrets: [stripeSecretKey] }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const stripe = getStripeClient();

  try {
    const { dropId, items, customerName, customerEmail, customerPhone, returnUrl } = req.body;

    if (!dropId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Invalid order details. Please select items." });
    }

    if (!customerEmail || !customerName) {
      return res.status(400).json({ error: "Name and email are required for preorder." });
    }

    // 1. Fetch Drop document and verify it is active and before cutoff
    const dropRef = db.collection("drops").doc(dropId);
    const dropDoc = await dropRef.get();

    if (!dropDoc.exists) {
      return res.status(404).json({ error: "Drop not found." });
    }

    const dropData = dropDoc.data();
    const now = new Date();
    const cutoffDate = dropData.cutoffAt ? dropData.cutoffAt.toDate() : null;

    if (dropData.status !== "active") {
      return res.status(400).json({ error: "Preorders are currently closed for this drop." });
    }

    if (cutoffDate && now > cutoffDate) {
      // Auto-update drop status if cutoff reached
      await dropRef.update({ status: "closed" });
      return res.status(400).json({ error: "Preorder cutoff deadline has passed." });
    }

    // 2. Validate requested flavor stock and construct Stripe line items
    // First, aggregate total bagel units requested per flavorId
    const flavorBagelRequests = {};
    for (const item of items) {
      const bundle = item.bundle || "dozen";
      const bagelsPerBundle = bundle === "half" ? 6 : (bundle === "dozen" ? 12 : 1);
      const totalBagels = (item.quantity || 1) * bagelsPerBundle;
      flavorBagelRequests[item.flavorId] = (flavorBagelRequests[item.flavorId] || 0) + totalBagels;
    }

    // Verify stock for each flavor
    const flavorDocsCache = {};
    for (const flavorId of Object.keys(flavorBagelRequests)) {
      const flavorRef = dropRef.collection("flavors").doc(flavorId);
      const flavorDoc = await flavorRef.get();
      if (!flavorDoc.exists) {
        return res.status(400).json({ error: `Flavor ${flavorId} not found.` });
      }
      flavorDocsCache[flavorId] = flavorDoc;
      const flavor = flavorDoc.data();
      const remaining = (flavor.totalInventory || 0) - (flavor.soldCount || 0);
      const requested = flavorBagelRequests[flavorId];
      if (requested > remaining) {
        return res.status(400).json({
          error: `Sorry! You requested ${requested} ${flavor.name} bagels, but only ${Math.max(0, remaining)} are left in stock.`
        });
      }
    }

    const lineItems = [];
    const orderItemsSummary = [];

    for (const item of items) {
      const flavorDoc = flavorDocsCache[item.flavorId];
      const flavor = flavorDoc.data();
      const bundle = item.bundle || "dozen";
      let unitPrice = 0;
      let bundleLabel = "";
      let bagelsPerUnit = 0;

      if (bundle === "half") {
        unitPrice = flavor.priceHalf != null ? flavor.priceHalf : (flavor.price ? flavor.price * 6 : 18.00);
        bundleLabel = "Half Dozen (6 Bagels)";
        bagelsPerUnit = 6;
      } else if (bundle === "dozen") {
        unitPrice = flavor.priceFull != null ? flavor.priceFull : (flavor.price ? flavor.price * 12 : 28.00);
        bundleLabel = "Full Dozen (12 Bagels)";
        bagelsPerUnit = 12;
      } else {
        unitPrice = flavor.price || 3.50;
        bundleLabel = "Single";
        bagelsPerUnit = 1;
      }

      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: {
            name: `${flavor.name} Bagels - ${bundleLabel}`,
            description: `Beach'n Bagels - ${dropData.title || "Pop-up Drop"}`,
            metadata: {
              flavorId: item.flavorId,
              dropId: dropId,
              bundle: bundle
            }
          },
          unit_amount: Math.round(unitPrice * 100) // Price in cents
        },
        quantity: item.quantity
      });

      orderItemsSummary.push({
        flavorId: item.flavorId,
        flavorName: flavor.name,
        bundle: bundle,
        bundleLabel: bundleLabel,
        quantity: item.quantity,
        bagelUnits: bagelsPerUnit * item.quantity,
        unitPrice: unitPrice,
        subtotal: unitPrice * item.quantity
      });
    }

    const origin = returnUrl || req.headers.origin || "https://beachnbagels.com";

    // 3. Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      customer_email: customerEmail,
      metadata: {
        dropId: dropId,
        customerName: customerName,
        customerEmail: customerEmail,
        customerPhone: customerPhone || "",
        itemsJson: JSON.stringify(orderItemsSummary)
      },
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // 30 minute checkout window
      success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&success=true`,
      cancel_url: `${origin}/?canceled=true`
    });

    return res.status(200).json({ sessionUrl: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * Stripe Webhook Handler.
 * Confirms payment and atomically increments sold counts & logs the order.
 */
exports.stripeWebhook = onRequest({ secrets: [stripeSecretKey, stripeWebhookSecret] }, async (req, res) => {
  const stripe = getStripeClient();
  const sig = req.headers["stripe-signature"];
  const endpointSecret = stripeWebhookSecret.value() || process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig, endpointSecret);
    } else {
      // In local testing or without webhook secret configured
      event = req.body;
    }
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful checkout
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { dropId, customerName, customerEmail, customerPhone, itemsJson } = session.metadata || {};

    if (!dropId || !itemsJson) {
      console.warn("Received checkout without required metadata:", session.id);
      return res.status(200).json({ received: true });
    }

    const items = JSON.parse(itemsJson);

    try {
      // Run atomic transaction to record order and update inventory soldCount
      await db.runTransaction(async (transaction) => {
        const dropRef = db.collection("drops").doc(dropId);
        const orderRef = db.collection("orders").doc(session.id);

        // Check if order was already processed (idempotency)
        const existingOrder = await transaction.get(orderRef);
        if (existingOrder.exists) {
          return;
        }

        // Step 1: Aggregate bagel units per flavorId
        const unitsPerFlavor = {};
        for (const item of items) {
          const units = item.bagelUnits != null ? item.bagelUnits : (
            item.bundle === "half" ? (item.quantity || 1) * 6 : (
              item.bundle === "dozen" ? (item.quantity || 1) * 12 : (item.quantity || 1)
            )
          );
          unitsPerFlavor[item.flavorId] = (unitsPerFlavor[item.flavorId] || 0) + units;
        }

        // Execute ALL READS first (Firestore transaction requirement)
        let allSoldOut = true;
        const flavorUpdates = [];

        for (const flavorId of Object.keys(unitsPerFlavor)) {
          const flavorRef = dropRef.collection("flavors").doc(flavorId);
          const flavorDoc = await transaction.get(flavorRef);

          if (flavorDoc.exists) {
            const data = flavorDoc.data();
            const newSoldCount = (data.soldCount || 0) + unitsPerFlavor[flavorId];
            flavorUpdates.push({ ref: flavorRef, newSoldCount });

            if (newSoldCount < (data.totalInventory || 0)) {
              allSoldOut = false;
            }
          }
        }

        // Step 2: Execute ALL WRITES after all reads
        for (const update of flavorUpdates) {
          transaction.update(update.ref, { soldCount: update.newSoldCount });
        }

        // If every flavor is completely sold, mark drop as sold_out
        if (allSoldOut) {
          transaction.update(dropRef, { status: "sold_out" });
        }

        // Create confirmed order document
        transaction.set(orderRef, {
          dropId,
          stripeSessionId: session.id,
          paymentIntentId: session.payment_intent,
          customerName,
          customerEmail,
          customerPhone: customerPhone || "",
          amountTotal: (session.amount_total || 0) / 100,
          currency: session.currency || "usd",
          items,
          pickupStatus: "unclaimed",
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      console.log(`Order ${session.id} successfully recorded.`);
    } catch (err) {
      console.error(`Transaction failed for session ${session.id}:`, err);
      return res.status(500).send("Transaction error");
    }
  }

  return res.status(200).json({ received: true });
});
