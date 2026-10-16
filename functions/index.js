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

    // 1. Fetch Drop and flavors inside an atomic transaction to verify available stock
    // and reserve bagels (reservedCount) before creating the Stripe checkout session.
    const dropRef = db.collection("drops").doc(dropId);

    // Aggregate total bagel units requested per flavorId
    const flavorBagelRequests = {};
    for (const item of items) {
      const bundle = item.bundle || "dozen";
      const bagelsPerBundle = bundle === "half" ? 6 : (bundle === "dozen" ? 12 : 1);
      const totalBagels = (item.quantity || 1) * bagelsPerBundle;
      flavorBagelRequests[item.flavorId] = (flavorBagelRequests[item.flavorId] || 0) + totalBagels;
    }

    let dropData;
    const flavorDocsCache = {};

    try {
      await db.runTransaction(async (transaction) => {
        const dropDoc = await transaction.get(dropRef);
        if (!dropDoc.exists) {
          throw new Error("Drop not found.");
        }

        dropData = dropDoc.data();
        const now = new Date();
        const cutoffDate = dropData.cutoffAt ? dropData.cutoffAt.toDate() : null;

        if (dropData.status !== "active") {
          throw new Error("Preorders are currently closed for this drop.");
        }

        if (cutoffDate && now > cutoffDate) {
          transaction.update(dropRef, { status: "closed" });
          throw new Error("Preorder cutoff deadline has passed.");
        }

        // Execute ALL READS first (Firestore transaction requirement)
        const flavorDataMap = {};
        for (const flavorId of Object.keys(flavorBagelRequests)) {
          const flavorRef = dropRef.collection("flavors").doc(flavorId);
          const flavorDoc = await transaction.get(flavorRef);
          if (!flavorDoc.exists) {
            throw new Error(`Flavor ${flavorId} not found.`);
          }
          const fData = flavorDoc.data();
          flavorDataMap[flavorId] = { ref: flavorRef, data: fData };

          const available = (fData.totalInventory || 0) - (fData.soldCount || 0) - (fData.reservedCount || 0);
          const requested = flavorBagelRequests[flavorId];
          if (requested > available) {
            throw new Error(
              `Sorry! You requested ${requested} ${fData.name || "bagel"} bagels, but only ${Math.max(0, available)} are currently available (another customer may be checking out).`
            );
          }
        }

        // Execute ALL WRITES after all reads
        for (const flavorId of Object.keys(flavorBagelRequests)) {
          const { ref, data } = flavorDataMap[flavorId];
          const currentReserved = data.reservedCount || 0;
          const requested = flavorBagelRequests[flavorId];
          transaction.update(ref, {
            reservedCount: currentReserved + requested
          });
          flavorDocsCache[flavorId] = data;
        }
      });
    } catch (txErr) {
      console.warn("Stock reservation transaction failed:", txErr.message);
      return res.status(400).json({ error: txErr.message || "Failed to reserve bagels." });
    }

    // 2. Build Stripe line items and order summary
    const lineItems = [];
    const orderItemsSummary = [];

    for (const item of items) {
      const flavor = flavorDocsCache[item.flavorId] || {};
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
            name: `${flavor.name || "Bagels"} - ${bundleLabel}`,
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
        flavorName: flavor.name || "Bagels",
        bundle: bundle,
        bundleLabel: bundleLabel,
        quantity: item.quantity,
        bagelUnits: bagelsPerUnit * item.quantity,
        unitPrice: unitPrice,
        subtotal: unitPrice * item.quantity
      });
    }

    const origin = returnUrl || req.headers.origin || "https://beachnbagels.com";

    // 3. Construct session metadata respecting Stripe's 500-char limit per value
    const sessionMetadata = {
      dropId: dropId,
      customerName: customerName,
      customerEmail: customerEmail,
      customerPhone: customerPhone || ""
    };

    const fullItemsJson = JSON.stringify(orderItemsSummary);
    if (fullItemsJson.length <= 500) {
      sessionMetadata.itemsJson = fullItemsJson;
    } else {
      // Chunk across items_0, items_1, etc. (each chunk max 450 characters)
      const chunkSize = 450;
      let chunkIdx = 0;
      for (let i = 0; i < fullItemsJson.length; i += chunkSize) {
        sessionMetadata[`items_${chunkIdx}`] = fullItemsJson.slice(i, i + chunkSize);
        chunkIdx++;
      }
    }

    // 4. Create Stripe Checkout Session (30 minute hold window)
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: lineItems,
        mode: "payment",
        customer_email: customerEmail,
        metadata: sessionMetadata,
        expires_at: Math.floor(Date.now() / 1000) + (30 * 60), // 30 minute checkout window
        success_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}&success=true`,
        cancel_url: `${origin}/?canceled=true`
      });
    } catch (stripeErr) {
      console.error("Stripe session creation failed, rolling back reservation hold:", stripeErr);
      // Rollback reservation hold immediately
      await db.runTransaction(async (rbTx) => {
        for (const flavorId of Object.keys(flavorBagelRequests)) {
          const fRef = dropRef.collection("flavors").doc(flavorId);
          const fDoc = await rbTx.get(fRef);
          if (fDoc.exists) {
            const curReserved = fDoc.data().reservedCount || 0;
            rbTx.update(fRef, {
              reservedCount: Math.max(0, curReserved - flavorBagelRequests[flavorId])
            });
          }
        }
      }).catch(rbFail => console.error("Rollback transaction error:", rbFail));

      return res.status(500).json({ error: "Failed to initialize payment with Stripe. Please try again." });
    }

    // 5. Store pending order in Firestore keyed by session.id
    try {
      await db.collection("pendingOrders").doc(session.id).set({
        status: "pending",
        dropId,
        customerName,
        customerEmail,
        customerPhone: customerPhone || "",
        items: orderItemsSummary,
        flavorBagelRequests,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      });
    } catch (saveErr) {
      console.warn("Could not save pendingOrders doc:", saveErr.message);
    }

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
    const metadata = session.metadata || {};
    let dropId = metadata.dropId;
    let customerName = metadata.customerName || (session.customer_details && session.customer_details.name) || "";
    let customerEmail = metadata.customerEmail || session.customer_email || (session.customer_details && session.customer_details.email) || "";
    let customerPhone = metadata.customerPhone || (session.customer_details && session.customer_details.phone) || "";
    let items = null;

    // Source 1: Check pendingOrders document in Firestore
    try {
      const pendingDoc = await db.collection("pendingOrders").doc(session.id).get();
      if (pendingDoc.exists) {
        const pData = pendingDoc.data();
        if (Array.isArray(pData.items) && pData.items.length > 0) {
          items = pData.items;
        }
        if (pData.dropId) dropId = pData.dropId;
        if (pData.customerName) customerName = pData.customerName;
        if (pData.customerEmail) customerEmail = pData.customerEmail;
        if (pData.customerPhone) customerPhone = pData.customerPhone;
      }
    } catch (err) {
      console.warn(`Error reading pendingOrders/${session.id}:`, err.message);
    }

    // Source 2: Reconstruct items from session metadata (itemsJson or chunked items_0, items_1...)
    if (!items) {
      if (metadata.itemsJson) {
        try {
          items = JSON.parse(metadata.itemsJson);
        } catch (e) {
          console.warn("Failed to parse metadata.itemsJson:", e.message);
        }
      } else {
        let combined = "";
        let idx = 0;
        while (metadata[`items_${idx}`]) {
          combined += metadata[`items_${idx}`];
          idx++;
        }
        if (combined) {
          try {
            items = JSON.parse(combined);
          } catch (e) {
            console.warn("Failed to parse chunked items metadata:", e.message);
          }
        }
      }
    }

    // Source 3: Fallback reconstruct items from Stripe line items if needed
    if (!items || !Array.isArray(items) || items.length === 0) {
      try {
        const lineItemsList = await stripe.checkout.sessions.listLineItems(session.id, { expand: ["data.price.product"] });
        if (lineItemsList && lineItemsList.data && lineItemsList.data.length > 0) {
          items = lineItemsList.data.map(li => {
            const prod = li.price && li.price.product;
            const meta = (prod && prod.metadata) || {};
            const bundle = meta.bundle || "dozen";
            const bagelsPerUnit = bundle === "half" ? 6 : (bundle === "dozen" ? 12 : 1);
            if (!dropId && meta.dropId) dropId = meta.dropId;
            return {
              flavorId: meta.flavorId,
              flavorName: li.description || (prod && prod.name) || "Bagels",
              bundle: bundle,
              bundleLabel: bundle === "half" ? "Half Dozen (6 Bagels)" : (bundle === "dozen" ? "Full Dozen (12 Bagels)" : "Single"),
              quantity: li.quantity,
              bagelUnits: bagelsPerUnit * li.quantity,
              unitPrice: (li.price && li.price.unit_amount) ? li.price.unit_amount / 100 : 0,
              subtotal: (li.amount_total != null) ? li.amount_total / 100 : 0
            };
          });
        }
      } catch (liErr) {
        console.warn("Could not list line items from Stripe:", liErr.message);
      }
    }

    if (!dropId || !items || !Array.isArray(items) || items.length === 0) {
      console.warn("Received checkout without required dropId or items:", session.id);
      return res.status(200).json({ received: true });
    }

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
            const units = unitsPerFlavor[flavorId];
            const newSoldCount = (data.soldCount || 0) + units;
            const newReservedCount = Math.max(0, (data.reservedCount || 0) - units);
            flavorUpdates.push({ ref: flavorRef, newSoldCount, newReservedCount });

            if (newSoldCount < (data.totalInventory || 0)) {
              allSoldOut = false;
            }
          }
        }

        // Step 2: Execute ALL WRITES after all reads
        for (const update of flavorUpdates) {
          transaction.update(update.ref, {
            soldCount: update.newSoldCount,
            reservedCount: update.newReservedCount
          });
        }

        // If every flavor is completely sold, mark drop as sold_out
        if (allSoldOut) {
          transaction.update(dropRef, { status: "sold_out" });
        }

        // Clean up pending order doc
        const pendingRef = db.collection("pendingOrders").doc(session.id);
        transaction.delete(pendingRef);

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

  // Handle expired checkout session (e.g. user abandoned checkout after 30 mins)
  if (event.type === "checkout.session.expired") {
    const session = event.data.object;
    try {
      await releaseHoldHelper(session.id);
      console.log(`Reservation hold released for expired session ${session.id}`);
    } catch (err) {
      console.error(`Error handling expired session ${session.id}:`, err);
    }
    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true });
});

/**
 * Helper to release an inventory reservation hold for an uncompleted Stripe session.
 * Guaranteed idempotent: only releases if pendingOrders doc has status: "pending".
 */
async function releaseHoldHelper(sessionId) {
  const pendingRef = db.collection("pendingOrders").doc(sessionId);

  await db.runTransaction(async (transaction) => {
    const pendingDoc = await transaction.get(pendingRef);
    if (!pendingDoc.exists) {
      return;
    }

    const pData = pendingDoc.data();
    if (pData.status !== "pending") {
      return;
    }

    const dropId = pData.dropId;
    if (!dropId) {
      transaction.update(pendingRef, { status: "released" });
      return;
    }

    const dropRef = db.collection("drops").doc(dropId);

    // Compute units to release per flavor
    const unitsPerFlavor = pData.flavorBagelRequests || {};
    if (Object.keys(unitsPerFlavor).length === 0 && Array.isArray(pData.items)) {
      for (const item of pData.items) {
        const units = item.bagelUnits != null ? item.bagelUnits : (
          item.bundle === "half" ? (item.quantity || 1) * 6 : (
            item.bundle === "dozen" ? (item.quantity || 1) * 12 : (item.quantity || 1)
          )
        );
        unitsPerFlavor[item.flavorId] = (unitsPerFlavor[item.flavorId] || 0) + units;
      }
    }

    // Step 1: Read all flavor docs first
    const flavorUpdates = [];
    for (const flavorId of Object.keys(unitsPerFlavor)) {
      const flavorRef = dropRef.collection("flavors").doc(flavorId);
      const flavorDoc = await transaction.get(flavorRef);
      if (flavorDoc.exists) {
        const curReserved = flavorDoc.data().reservedCount || 0;
        const toRelease = unitsPerFlavor[flavorId];
        const newReserved = Math.max(0, curReserved - toRelease);
        flavorUpdates.push({ ref: flavorRef, newReserved });
      }
    }

    // Step 2: Write all flavor updates
    for (const u of flavorUpdates) {
      transaction.update(u.ref, { reservedCount: u.newReserved });
    }

    // Step 3: Mark pendingOrder as released
    transaction.update(pendingRef, {
      status: "released",
      releasedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

/**
 * API endpoint to immediately release inventory hold when a customer cancels or returns.
 */
exports.releaseCheckoutHold = onRequest({ cors: true, secrets: [stripeSecretKey] }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  try {
    await releaseHoldHelper(sessionId);

    // Expire session on Stripe side so it cannot be reopened
    try {
      const stripe = getStripeClient();
      await stripe.checkout.sessions.expire(sessionId);
    } catch (_) {}

    return res.status(200).json({ released: true, sessionId });
  } catch (error) {
    console.error(`Error releasing checkout hold for ${sessionId}:`, error);
    return res.status(500).json({ error: error.message || "Failed to release hold" });
  }
});
