const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { Resend } = require("resend");

// Explicitly set region for Cloud Functions v2
setGlobalOptions({ region: "us-central1" });

// Define Cloud Secrets stored securely in Google Cloud Secret Manager
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const resendApiKey = defineSecret("RESEND_API_KEY");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

function getStripeClient() {
  const key = stripeSecretKey.value() || process.env.STRIPE_SECRET_KEY;
  return new Stripe(key);
}

function getResendClient() {
  const key = resendApiKey.value() || process.env.RESEND_API_KEY;
  return new Resend(key);
}

async function sendGenericEmail({ to, subject, html }) {
  const resend = getResendClient();
  const primaryFrom = "Beach'n Bagels <orders@beachnbagels.com>";
  const fallbackFrom = "Beach'n Bagels <onboarding@resend.dev>";
  const recipients = Array.isArray(to) ? to : [to];

  try {
    const res = await resend.emails.send({
      from: primaryFrom,
      to: recipients,
      subject,
      html
    });
    if (res && res.error) {
      if (res.error.message && res.error.message.includes("not verified")) {
        console.log("Domain beachnbagels.com not verified yet in Resend, attempting onboarding@resend.dev fallback");
        return await resend.emails.send({
          from: fallbackFrom,
          to: recipients,
          subject,
          html
        });
      }
      console.warn("Resend email warning:", res.error);
    }
    return res;
  } catch (err) {
    if (err.message && err.message.includes("not verified")) {
      return await resend.emails.send({
        from: fallbackFrom,
        to: recipients,
        subject,
        html
      });
    }
    console.error("Failed to send email:", err);
  }
}

async function sendAdminEmail({ subject, html }) {
  const to = [process.env.ADMIN_ALERT_EMAIL || "dylanastrup@gmail.com"];
  return sendGenericEmail({ to, subject, html });
}

async function sendNewOrderAlert({ session, customerName, customerEmail, customerPhone, items, drop }) {
  const totalDollars = ((session.amount_total || 0) / 100).toFixed(2);
  const dropTitle = (drop && drop.title) || "Pop-Up Drop";
  const itemsHtml = (items || []).map(item => `
    <tr style="border-bottom: 1px solid #e5e5e5;">
      <td style="padding: 10px 0; color: #1E414A;">
        <strong>${item.quantity}x</strong> ${item.flavorName || "Bagels"}
        <div style="font-size: 0.85rem; color: #737373;">${item.bundleLabel || item.bundle || ""}</div>
      </td>
      <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #2A5A66;">
        $${(item.subtotal || 0).toFixed(2)}
      </td>
    </tr>
  `).join("");

  await sendAdminEmail({
    subject: `🥯 New Preorder: ${customerName} ($${totalDollars})`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 2px solid #2A5A66; border-radius: 14px; background: #FDF6E9; color: #1E414A;">
        <div style="text-align: center; margin-bottom: 16px;">
          <span style="font-size: 2.5rem;">🥯</span>
          <h2 style="color: #2A5A66; margin: 8px 0 4px 0; font-size: 1.6rem;">New Bagel Preorder Received!</h2>
          <p style="font-size: 0.95rem; margin: 0; opacity: 0.85;">Drop: <strong>${dropTitle}</strong> • Payment confirmed via Stripe</p>
        </div>
        
        <div style="background: #ffffff; padding: 16px; border-radius: 10px; border: 1px solid #e5e5e5; margin-bottom: 16px;">
          <h4 style="margin: 0 0 10px 0; color: #2A5A66; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 0.5px;">Customer Details</h4>
          <p style="margin: 4px 0; font-size: 0.95rem;"><strong>Name:</strong> ${customerName}</p>
          <p style="margin: 4px 0; font-size: 0.95rem;"><strong>Email:</strong> <a href="mailto:${customerEmail}" style="color: #2A5A66;">${customerEmail}</a></p>
          <p style="margin: 4px 0; font-size: 0.95rem;"><strong>Phone:</strong> <a href="tel:${customerPhone}" style="color: #2A5A66;">${customerPhone || "Not provided"}</a></p>
        </div>

        <div style="background: #ffffff; padding: 16px; border-radius: 10px; border: 1px solid #e5e5e5; margin-bottom: 20px;">
          <h4 style="margin: 0 0 10px 0; color: #2A5A66; text-transform: uppercase; font-size: 0.8rem; letter-spacing: 0.5px;">Order Summary</h4>
          <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
            ${itemsHtml}
            <tr>
              <td style="padding: 14px 0 0 0; font-weight: bold; font-size: 1.15rem; color: #2A5A66;">Total Paid:</td>
              <td style="padding: 14px 0 0 0; text-align: right; font-weight: bold; font-size: 1.15rem; color: #2A5A66;">$${totalDollars}</td>
            </tr>
          </table>
        </div>

        <div style="text-align: center; margin-top: 20px;">
          <a href="https://beachnbagels.com/admin.html" style="background: #2A5A66; color: #FDBB4C; padding: 12px 24px; border-radius: 50px; text-decoration: none; font-weight: bold; font-size: 0.95rem; display: inline-block;">
            Open Baker Prep Sheet & Dashboard →
          </a>
        </div>
      </div>
    `
  });
}

async function sendCustomerConfirmationEmail({ session, customerName, customerEmail, customerPhone, items, drop }) {
  if (!customerEmail) return;

  const totalDollars = ((session.amount_total || 0) / 100).toFixed(2);
  const dropTitle = (drop && drop.title) || "Beach'n Bagels Pop-Up Drop";
  const pickupWindow = (drop && drop.pickupWindow) || "Saturday Morning";
  const pickupLocation = (drop && drop.pickupLocation) || "Silver Strand Beach, Oxnard, CA";
  const customNotes = (drop && (drop.confirmationNotes || drop.description)) || "";
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pickupLocation)}`;

  const itemsHtml = (items || []).map(item => `
    <tr style="border-bottom: 1px solid #e5e5e5;">
      <td style="padding: 10px 0; color: #1E414A;">
        <strong>${item.quantity}x</strong> ${item.flavorName || "Bagels"}
        <div style="font-size: 0.85rem; color: #737373;">${item.bundleLabel || item.bundle || ""}</div>
      </td>
      <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #2A5A66;">
        $${(item.subtotal || 0).toFixed(2)}
      </td>
    </tr>
  `).join("");

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 2px solid #2A5A66; border-radius: 14px; background: #FDF6E9; color: #1E414A;">
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="https://beachnbagels.com/favicon.png" alt="Beach'n Bagels Logo" style="width: 75px; height: 75px; border-radius: 50%; border: 2px solid #2A5A66; object-fit: cover;">
        <h1 style="font-size: 1.65rem; color: #2A5A66; margin: 10px 0 4px 0;">You're All Set! 🥯</h1>
        <p style="font-size: 1rem; color: #1E414A; margin: 0;">Thanks for preordering with Beach'n Bagels, <strong>${customerName}</strong>!</p>
      </div>

      <div style="background: #ffffff; border: 2px solid #2A5A66; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
        <h3 style="margin: 0 0 12px 0; font-size: 0.9rem; color: #2A5A66; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px;">
          📍 Pickup Details
        </h3>
        <p style="margin: 6px 0; font-size: 0.95rem;"><strong>Drop:</strong> ${dropTitle}</p>
        <p style="margin: 6px 0; font-size: 0.95rem;"><strong>⏰ Window:</strong> ${pickupWindow}</p>
        <p style="margin: 6px 0; font-size: 0.95rem;"><strong>📍 Location:</strong> ${pickupLocation}</p>
        <div style="margin-top: 10px;">
          <a href="${mapsUrl}" target="_blank" style="display: inline-block; background: #EBF2F4; color: #2A5A66; border: 1.5px solid #2A5A66; padding: 6px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: bold; text-decoration: none;">
            📍 Open in Google Maps ↗
          </a>
        </div>
        ${customNotes ? `
          <div style="margin-top: 14px; padding-top: 12px; border-top: 1px dashed #e5e5e5; font-size: 0.9rem; line-height: 1.45; color: #2A5A66; white-space: pre-line;">
            📝 <strong>Pickup Instructions & Notes:</strong><br>${customNotes}
          </div>
        ` : ''}
      </div>

      <div style="background: #ffffff; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
        <h3 style="margin: 0 0 12px 0; font-size: 0.9rem; color: #2A5A66; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e5e5; padding-bottom: 8px;">
          🥯 Order Summary
        </h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
          ${itemsHtml}
          <tr>
            <td style="padding: 14px 0 0 0; font-weight: bold; font-size: 1.15rem; color: #2A5A66;">Total Paid:</td>
            <td style="padding: 14px 0 0 0; text-align: right; font-weight: bold; font-size: 1.15rem; color: #2A5A66;">$${totalDollars}</td>
          </tr>
        </table>
      </div>

      <div style="background: #FEF3C7; border: 1px solid #F59E0B; border-radius: 10px; padding: 12px 16px; margin-bottom: 20px; font-size: 0.9rem; color: #92400E; line-height: 1.45;">
        <strong>When you arrive:</strong> Look for Ollie the Otter and our teal pop-up tent on the sand! Simply give your name (<strong>${customerName}</strong>) at the table and we'll hand you your fresh, hand-rolled bagels.
      </div>

      <div style="text-align: center; font-size: 0.85rem; opacity: 0.8; line-height: 1.5;">
        Questions or running late? Reply directly to this email or reach us at <a href="mailto:hello@beachnbagels.com" style="color: #2A5A66; font-weight: bold;">hello@beachnbagels.com</a>.<br>
        See you at Silver Strand! 🌊🥯
      </div>
    </div>
  `;

  await sendGenericEmail({
    to: [customerEmail],
    subject: `🥯 Preorder Confirmed! Beach'n Bagels - ${dropTitle}`,
    html: emailHtml
  });
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

      // Fetch drop details for rich email formatting
      let dropData = null;
      try {
        const dSnap = await db.collection("drops").doc(dropId).get();
        if (dSnap.exists) dropData = dSnap.data();
      } catch (_) {}

      // 1. Send baker notification email
      try {
        await sendNewOrderAlert({
          session,
          customerName,
          customerEmail,
          customerPhone,
          items,
          drop: dropData
        });
      } catch (emailErr) {
        console.error("Failed to send order alert email:", emailErr);
      }

      // 2. Send customer confirmation email with pickup details
      if (customerEmail) {
        try {
          await sendCustomerConfirmationEmail({
            session,
            customerName,
            customerEmail,
            customerPhone,
            items,
            drop: dropData
          });
        } catch (custEmailErr) {
          console.error("Failed to send customer confirmation email:", custEmailErr);
        }
      }
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

/**
 * Endpoint to add an email to the waitlist and instantly alert the baker.
 */
exports.submitWaitlist = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { email, source } = req.body || {};
  const cleanedEmail = (email || "").trim().toLowerCase();

  if (!cleanedEmail || !cleanedEmail.includes("@")) {
    return res.status(400).json({ error: "Please provide a valid email address." });
  }

  try {
    const docRef = await db.collection("waitlist").add({
      email: cleanedEmail,
      source: source || "landing_page",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send instant email notification to baker
    try {
      await sendAdminEmail({
        subject: `🎉 New Waitlist Signup: ${cleanedEmail}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 2px solid #2A5A66; border-radius: 14px; background: #FDF6E9; color: #1E414A;">
            <div style="text-align: center; margin-bottom: 16px;">
              <span style="font-size: 2.5rem;">🎉</span>
              <h2 style="color: #2A5A66; margin: 8px 0 4px 0;">New Bagel Club Member!</h2>
              <p style="font-size: 0.95rem; margin: 0; opacity: 0.85;">Someone just subscribed for drop alerts</p>
            </div>
            
            <div style="background: #ffffff; padding: 16px; border-radius: 10px; border: 1px solid #e5e5e5; text-align: center; margin-bottom: 16px;">
              <div style="font-size: 1.15rem; font-weight: bold; color: #2A5A66;">
                📧 ${cleanedEmail}
              </div>
              <div style="font-size: 0.85rem; color: #737373; margin-top: 6px;">
                Source: ${source || "landing_page"} • ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} (Pacific)
              </div>
            </div>

            <div style="text-align: center;">
              <a href="https://beachnbagels.com/admin.html" style="background: #FDBB4C; color: #1E414A; padding: 10px 20px; border-radius: 50px; text-decoration: none; font-weight: bold; font-size: 0.9rem; display: inline-block;">
                View Waitlist in Dashboard →
              </a>
            </div>
          </div>
        `
      });
      console.log(`Waitlist alert sent for ${cleanedEmail}`);
    } catch (emailErr) {
      console.warn("Failed to send waitlist alert email:", emailErr);
    }

    return res.status(200).json({ success: true, id: docRef.id });
  } catch (err) {
    console.error("Failed to add waitlist subscriber:", err);
    return res.status(500).json({ error: err.message || "Failed to join waitlist" });
  }
});

/**
 * Broadcasts an announcement email to waitlist subscribers when a drop is live.
 * Supports testOnly: true to send a preview to the baker before blasting.
 */
exports.broadcastDropToWaitlist = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { dropId, subject, headline, message, testOnly, testEmail } = req.body || {};

  // Load drop details
  let drop = null;
  if (dropId) {
    try {
      const dSnap = await db.collection("drops").doc(dropId).get();
      if (dSnap.exists) drop = dSnap.data();
    } catch (_) {}
  }

  const dropTitle = (drop && drop.title) || "New Pop-Up Drop";
  const pickupWindow = (drop && drop.pickupWindow) || "Saturday Morning";
  const pickupLocation = (drop && drop.pickupLocation) || "Silver Strand Beach, Oxnard";

  const emailSubject = subject || `🥯 Fresh Bagels Alert: Preorders are LIVE for ${dropTitle}!`;
  const emailHeadline = headline || `Preorders Are Live for ${dropTitle}!`;
  const emailMessage = message || `We’re firing up the kettle and hand-rolling fresh bagels for our upcoming beach drop at ${pickupLocation}. Quantities are limited—preorder yours now before we sell out!`;

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 2px solid #2A5A66; border-radius: 14px; background: #FDF6E9; color: #1E414A;">
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="https://beachnbagels.com/favicon.png" alt="Beach'n Bagels Logo" style="width: 75px; height: 75px; border-radius: 50%; border: 2px solid #2A5A66; object-fit: cover;">
        <h1 style="font-size: 1.65rem; color: #2A5A66; margin: 10px 0 4px 0;">${emailHeadline}</h1>
        <p style="font-size: 1rem; color: #1E414A; margin: 0;">Beach'n Bagels Pop-Up Alert</p>
      </div>

      <div style="background: #ffffff; border: 2px solid #2A5A66; border-radius: 12px; padding: 18px; margin-bottom: 20px;">
        <div style="font-size: 1rem; line-height: 1.55; color: #1E414A; white-space: pre-line; margin-bottom: 16px;">
          ${emailMessage}
        </div>
        
        <div style="background: #EBF2F4; padding: 12px 16px; border-radius: 8px; font-size: 0.95rem; border-left: 4px solid #2A5A66;">
          <p style="margin: 4px 0;"><strong>📍 Location:</strong> ${pickupLocation}</p>
          <p style="margin: 4px 0;"><strong>⏰ Pickup Window:</strong> ${pickupWindow}</p>
        </div>
      </div>

      <div style="text-align: center; margin: 26px 0;">
        <a href="https://beachnbagels.com" target="_blank" style="background: #2A5A66; color: #FDBB4C; padding: 14px 30px; border-radius: 50px; text-decoration: none; font-weight: bold; font-size: 1.1rem; display: inline-block; box-shadow: 0 4px 12px rgba(42,90,102,0.25);">
          Preorder Your Bagels Now →
        </a>
      </div>

      <div style="text-align: center; font-size: 0.8rem; opacity: 0.75; line-height: 1.4; border-top: 1px dashed rgba(42,90,102,0.2); padding-top: 14px;">
        You received this because you signed up for the Beach'n Bagels Club at beachnbagels.com.<br>
        Oxnard, CA • Hand-rolled, boiled and baked fresh.
      </div>
    </div>
  `;

  if (testOnly) {
    const targetEmail = testEmail || process.env.ADMIN_ALERT_EMAIL || "dylanastrup@gmail.com";
    await sendGenericEmail({
      to: [targetEmail],
      subject: `[TEST PREVIEW] ${emailSubject}`,
      html: emailHtml
    });
    return res.status(200).json({ success: true, test: true, recipient: targetEmail });
  }

  // Live broadcast: load waitlist emails
  try {
    const snapshot = await db.collection("waitlist").get();
    const emails = [];
    snapshot.forEach(doc => {
      const em = doc.data().email;
      if (em && em.includes("@")) emails.push(em.toLowerCase().trim());
    });

    const uniqueEmails = Array.from(new Set(emails));
    let sentCount = 0;

    for (const recipient of uniqueEmails) {
      try {
        await sendGenericEmail({
          to: [recipient],
          subject: emailSubject,
          html: emailHtml
        });
        sentCount++;
      } catch (sendErr) {
        console.warn(`Failed to send broadcast to ${recipient}:`, sendErr.message);
      }
    }

    return res.status(200).json({ success: true, count: sentCount, total: uniqueEmails.length });
  } catch (err) {
    console.error("Failed to broadcast to waitlist:", err);
    return res.status(500).json({ error: err.message || "Failed to broadcast" });
  }
});

/**
 * Sends a test customer order confirmation receipt to the baker
 * so they can review pickup notes and layout before launch.
 */
exports.sendTestOrderReceipt = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { dropId, recipientEmail } = req.body || {};
  const targetEmail = recipientEmail || process.env.ADMIN_ALERT_EMAIL || "dylanastrup@gmail.com";

  let drop = null;
  if (dropId) {
    try {
      const snap = await db.collection("drops").doc(dropId).get();
      if (snap.exists) drop = snap.data();
    } catch (_) {}
  }

  try {
    await sendCustomerConfirmationEmail({
      session: { amount_total: 4600 },
      customerName: "Dylan Astrup (Test Preview)",
      customerEmail: targetEmail,
      customerPhone: "(805) 555-0123",
      items: [
        { flavorName: "Everything", quantity: 1, bundle: "dozen", price: 28 },
        { flavorName: "Plain", quantity: 1, bundle: "half", price: 18 }
      ],
      drop
    });
    return res.status(200).json({ success: true, recipient: targetEmail });
  } catch (err) {
    console.error("Failed to send test customer receipt:", err);
    return res.status(500).json({ error: err.message || "Failed to send test receipt" });
  }
});
