/**
 * Rice & Shine — order confirmation emails
 *
 * Two triggers, both on the onlineOrders collection:
 *   - a new order  -> "we've got your order"
 *   - a changed order -> "here's your order now"
 *
 * Why this runs on the server rather than in the page: the page belongs to
 * the customer's browser, and a browser can be closed the instant the order
 * saves. An email fired from there is an email that sometimes doesn't get
 * sent. Firestore triggers fire from the write itself, so the email follows
 * the order rather than the tab.
 *
 * It also means the Resend key never goes near the website. A key shipped in
 * page source is a key anyone can lift and send mail as Rice & Shine with.
 *
 * ---- One-time setup (Tony) ----
 * From the project folder, with the Firebase CLI installed:
 *
 *   firebase functions:secrets:set RESEND_API_KEY
 *
 * That opens a prompt — paste the key from Resend into it. It goes straight
 * from your terminal into Google's secret store. Don't paste it into a chat,
 * a file, or this repo.
 *
 *   cd functions && npm install
 *   firebase deploy --only functions
 *
 * Cloud Functions needs the Blaze (pay-as-you-go) plan. For this volume it
 * costs essentially nothing — the free monthly allowance is far above a few
 * hundred order emails — but the card has to be on file before it will
 * deploy.
 */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");

// us-west1 is the closest region to Vacaville; it only affects latency by a
// few tens of milliseconds here, but there's no reason to send these through
// the other side of the country.
setGlobalOptions({ region: "us-west1", maxInstances: 5 });

const FROM = "Rice & Shine <orders@ricenshine.net>";
const REPLY_TO = "htran42595@gmail.com";
const SITE = "https://ricenshine.net";
const IG = "ricenshine.sushibake";

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function money(n) {
  return "$" + (Math.round(Number(n) || 0) === Number(n)
    ? String(Number(n) || 0)
    : (Number(n) || 0).toFixed(2));
}

// "2026-09-14" -> "Monday, September 14". Built by hand rather than with
// toLocaleDateString because a bare ISO date parsed as UTC lands on the
// previous evening in California, which would print the wrong day — the same
// timezone trap that has bitten the pickup dates before.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function friendlyDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function itemRows(items) {
  return (items || []).map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #e6dcef;color:#251a38;font-size:15px">
        ${esc(it.qty)} &times; ${esc(it.name)}
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #e6dcef;color:#251a38;font-size:15px;text-align:right;white-space:nowrap">
        ${esc(money((Number(it.price) || 0) * (Number(it.qty) || 0)))}
      </td>
    </tr>`).join("");
}

/**
 * One template for both emails. They differ only in the headline and the
 * opening line, so keeping them as one function is what stops the "updated"
 * email quietly drifting out of step with the "received" one.
 *
 * Written as table-based HTML with inline styles on purpose: that is what
 * survives Gmail, Outlook and Apple Mail, all of which strip <style> blocks
 * or ignore flexbox. Plain text version below it, because some people read
 * mail that way and a blank message reads as a broken business.
 */
function renderEmail({ heading, lead, order, orderId, showEditLink }) {
  const editUrl = `${SITE}/?order=${encodeURIComponent(orderId)}`;
  const ref = String(orderId).slice(-6).toUpperCase();

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8f2c2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f2c2;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:520px;background:#fffdf3;border-radius:14px;overflow:hidden;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

      <tr><td style="background:#2c2140;padding:20px 24px">
        <div style="color:#f8f2c2;font-size:20px;font-weight:700;letter-spacing:.3px">Rice &amp; Shine</div>
        <div style="color:#ada0be;font-size:13px;margin-top:2px">Sushi bake, made fresh</div>
      </td></tr>

      <tr><td style="padding:26px 24px 6px">
        <h1 style="margin:0 0 8px;font-size:22px;color:#251a38">${esc(heading)}</h1>
        <p style="margin:0;font-size:15px;line-height:1.55;color:#6f6280">${esc(lead)}</p>
      </td></tr>

      <tr><td style="padding:18px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="background:#efe4a8;border-radius:10px">
          <tr><td style="padding:16px 18px;text-align:center">
            <div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:#6f6280">Pick up your order</div>
            <div style="font-size:19px;font-weight:700;color:#251a38;margin-top:6px">${esc(friendlyDate(order.pickupDate))}</div>
            <div style="font-size:16px;color:#251a38;margin-top:2px">${esc(order.pickupTime)}</div>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:22px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${itemRows(order.items)}
          <tr>
            <td style="padding:12px 0 0;font-size:16px;font-weight:700;color:#251a38">Total</td>
            <td style="padding:12px 0 0;font-size:16px;font-weight:700;color:#251a38;text-align:right">${esc(money(order.total))}</td>
          </tr>
        </table>
        <p style="margin:14px 0 0;font-size:13px;color:#6f6280">
          Pay at pickup — Venmo, Zelle, Apple Pay or cash. Nothing is owed now.
        </p>
      </td></tr>

      ${order.notes ? `
      <tr><td style="padding:16px 24px 0">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6f6280">Your notes</div>
        <div style="font-size:14px;color:#251a38;margin-top:4px;line-height:1.5">${esc(order.notes)}</div>
      </td></tr>` : ""}

      ${showEditLink ? `
      <tr><td style="padding:22px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
               style="border:1px solid #e6dcef;border-radius:10px">
          <tr><td style="padding:16px 18px">
            <div style="font-size:15px;font-weight:600;color:#251a38">Need to change something?</div>
            <div style="font-size:13px;color:#6f6280;margin-top:4px;line-height:1.5">
              You can update this order yourself up until 24 hours before pickup.
            </div>
            <a href="${esc(editUrl)}"
               style="display:inline-block;margin-top:12px;background:#7a58ad;color:#ffffff;
                      text-decoration:none;font-size:14px;font-weight:600;
                      padding:10px 18px;border-radius:8px">View or change my order</a>
          </td></tr>
        </table>
      </td></tr>` : ""}

      <tr><td style="padding:22px 24px 26px">
        <div style="font-size:12px;color:#6f6280;text-align:center">
          Order reference <strong style="color:#251a38">${esc(ref)}</strong>
        </div>
        <div style="font-size:12px;color:#6f6280;text-align:center;margin-top:10px;line-height:1.6">
          Questions, or something we can't change online?<br>
          Message us on Instagram <strong style="color:#251a38">@${esc(IG)}</strong>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  const text = [
    heading,
    "",
    lead,
    "",
    `Pickup: ${friendlyDate(order.pickupDate)} at ${order.pickupTime}`,
    "",
    ...(order.items || []).map((it) => `  ${it.qty} x ${it.name}  ${money((Number(it.price) || 0) * (Number(it.qty) || 0))}`),
    `  Total: ${money(order.total)}`,
    "",
    "Pay at pickup - Venmo, Zelle, Apple Pay or cash. Nothing is owed now.",
    ...(order.notes ? ["", `Your notes: ${order.notes}`] : []),
    ...(showEditLink ? ["", "View or change your order (up to 24 hours before pickup):", editUrl] : []),
    "",
    `Order reference ${ref}`,
    `Questions? Message us on Instagram @${IG}`,
  ].join("\n");

  return { html, text };
}

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, html, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

function validEmail(v) {
  const s = String(v || "").trim();
  return s.length >= 5 && s.length <= 120 && /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(s);
}

// ---------------------------------------------------------------------------
// triggers
// ---------------------------------------------------------------------------

exports.sendOrderConfirmation = onDocumentCreated(
  { document: "onlineOrders/{orderId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const order = snap.data();
    const orderId = event.params.orderId;

    if (!validEmail(order.email)) {
      logger.warn("No usable email on new order, skipping confirmation", { orderId });
      return;
    }

    // A trigger can be delivered more than once — that is normal, not a
    // fault, and without a guard a retry means the customer gets the same
    // confirmation twice. Claiming the send first makes a duplicate delivery
    // a no-op instead.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(snap.ref);
      if (!fresh.exists || fresh.get("confirmationSentAt")) return false;
      tx.update(snap.ref, {
        confirmationSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (!claimed) {
      logger.info("Confirmation already sent, skipping", { orderId });
      return;
    }

    const firstName = String(order.name || "").split(" ")[0];
    const { html, text } = renderEmail({
      heading: "Order received",
      lead: `Thanks ${firstName}, we've got your order. Nothing else is needed from you — just come by at your pickup time.`,
      order, orderId, showEditLink: true,
    });

    try {
      await sendEmail({
        to: order.email,
        subject: `Your Rice & Shine order — ${friendlyDate(order.pickupDate)}, ${order.pickupTime}`,
        html, text,
      });
      logger.info("Confirmation sent", { orderId });
    } catch (err) {
      // Release the claim so a retry can try again, rather than leaving the
      // order marked as confirmed when nothing was actually delivered.
      await snap.ref.update({
        confirmationSentAt: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      logger.error("Confirmation failed", { orderId, err: String(err) });
      throw err;
    }
  }
);

// Which fields, if they change, mean the customer's order is genuinely
// different and worth an email. Deliberately excludes ownerUid (set when
// someone signs in), paid (staff marking payment), and the bookkeeping
// fields — none of those change what the customer is picking up, and mailing
// them about it would train people to ignore these emails.
const CUSTOMER_FACING = ["items", "total", "pickupDate", "pickupTime", "notes"];

exports.sendOrderUpdate = onDocumentUpdated(
  { document: "onlineOrders/{orderId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;

    const changed = CUSTOMER_FACING.filter(
      (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)
    );
    if (!changed.length) return;

    if (!validEmail(after.email)) {
      logger.warn("No usable email on updated order, skipping", { orderId });
      return;
    }

    const firstName = String(after.name || "").split(" ")[0];
    const movedDay = before.pickupDate !== after.pickupDate
      || before.pickupTime !== after.pickupTime;

    const { html, text } = renderEmail({
      heading: "Order updated",
      lead: movedDay
        ? `Thanks ${firstName}, your changes are saved. Note the new pickup time below.`
        : `Thanks ${firstName}, your changes are saved. This is your order now.`,
      order: after, orderId, showEditLink: true,
    });

    try {
      await sendEmail({
        to: after.email,
        subject: `Your Rice & Shine order was updated — ${friendlyDate(after.pickupDate)}, ${after.pickupTime}`,
        html, text,
      });
      logger.info("Update email sent", { orderId, changed });
    } catch (err) {
      logger.error("Update email failed", { orderId, err: String(err) });
      throw err;
    }
  }
);

/**
 * Staff accepting or declining an order.
 *
 * The site auto-confirms everything, so this only fires for the exceptions
 * Tony marks by hand on the board. Two things are worth noting:
 *
 * A declined order keeps its edit link working but the page shows it as
 * declined, so the customer isn't left clicking a link that appears to offer
 * changes to an order that isn't happening.
 *
 * The note is not optional on a decline — the board refuses to send without
 * one — because "we can't make your order" with no reason forces the customer
 * to come and ask, which costs exactly the conversation this was meant to
 * save.
 */
exports.sendOrderStatusEmail = onDocumentUpdated(
  { document: "onlineOrders/{orderId}", secrets: [RESEND_API_KEY] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;

    const wasStatus = before.status || "";
    const nowStatus = after.status || "";
    const noteChanged = (before.statusNote || "") !== (after.statusNote || "");

    // Clearing the mark, or an unrelated write, sends nothing. Re-sending on
    // a note tweak alone would let a typo fix mail the customer twice.
    if (nowStatus === wasStatus && !(nowStatus && noteChanged && !wasStatus)) return;
    if (!nowStatus) {
      logger.info("Status cleared, no email", { orderId });
      return;
    }
    if (!validEmail(after.email)) {
      logger.warn("No usable email for status change, skipping", { orderId });
      return;
    }

    const firstName = String(after.name || "").split(" ")[0];
    const declined = nowStatus === "declined";
    const note = String(after.statusNote || "").trim();

    const { html, text } = renderEmail({
      heading: declined ? "About your order" : "Your order is confirmed",
      lead: declined
        ? `${firstName}, we're sorry — we can't take this one after all.` +
          (note ? ` ${note}` : "") +
          " Nothing is owed, and there's nothing you need to do."
        : `${firstName}, we've got you.` + (note ? ` ${note}` : "") +
          " See you at pickup.",
      order: after, orderId,
      // A declined order has nothing left to change, and offering a "change
      // my order" button on it would be a small cruelty.
      showEditLink: !declined,
    });

    try {
      await sendEmail({
        to: after.email,
        subject: declined
          ? "About your Rice & Shine order"
          : `Your Rice & Shine order is confirmed — ${friendlyDate(after.pickupDate)}, ${after.pickupTime}`,
        html, text,
      });
      logger.info("Status email sent", { orderId, status: nowStatus });
    } catch (err) {
      logger.error("Status email failed", { orderId, err: String(err) });
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// The sign-in email
// ---------------------------------------------------------------------------

/**
 * Sends the "click to sign in" email for editing an order.
 *
 * Firebase can send this itself, in one line, from the browser. The reason it
 * doesn't is that the message it sends can't be changed: the Firebase console
 * exposes templates for password reset, email change and verification, and
 * nothing for passwordless sign-in. So the first email a customer gets when
 * they try to change an order would arrive from
 * noreply@rice-shine-order-board.firebaseapp.com, in Firebase's own wording,
 * looking nothing like the confirmation they got an hour earlier. That reads
 * like a phishing attempt, which is exactly the wrong feeling to give someone
 * about a link they're being asked to click.
 *
 * So the link is generated here with the Admin SDK and sent through Resend
 * with the same template as everything else. The link itself is identical to
 * the one Firebase would have mailed, so signInWithEmailLink on the page is
 * unchanged.
 *
 * Two guards, and both matter:
 *
 *   - App Check, so this can only be called from the real website. Without
 *     it this is an open endpoint that emails arbitrary addresses on demand,
 *     which is a spam relay with Rice & Shine's name on it.
 *   - The address must actually appear on an order. Even from the real site,
 *     letting anyone type any address and have mail sent to it is the same
 *     problem wearing a nicer hat.
 */
exports.sendSignInEmail = onCall(
  { secrets: [RESEND_API_KEY], enforceAppCheck: true, maxInstances: 5 },
  async (request) => {
    const email = String((request.data && request.data.email) || "").trim().toLowerCase();
    const continueUrl = String((request.data && request.data.continueUrl) || "").trim();

    if (!validEmail(email)) {
      throw new HttpsError("invalid-argument", "That email address doesn't look right.");
    }
    // Only ever send people back to our own site.
    if (!/^https:\/\/ricenshine\.net(\/|$)/.test(continueUrl)) {
      throw new HttpsError("invalid-argument", "Bad return address.");
    }

    const match = await db.collection("onlineOrders")
      .where("email", "==", email).limit(1).get();
    if (match.empty) {
      // Deliberately vague to the caller: confirming whether an address has
      // ordered here would turn this into a way to test whether someone is a
      // customer. The page shows the same "check your email" screen either
      // way, so a stranger learns nothing.
      logger.info("Sign-in email requested for an address with no orders");
      return { ok: true };
    }

    let link;
    try {
      link = await admin.auth().generateSignInWithEmailLink(email, {
        url: continueUrl,
        handleCodeInApp: true,
      });
    } catch (err) {
      logger.error("Could not generate sign-in link", { err: String(err) });
      throw new HttpsError("internal", "Could not create a sign-in link.");
    }

    const name = String(match.docs[0].get("name") || "").split(" ")[0];
    const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8f2c2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f2c2;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="max-width:520px;background:#fffdf3;border-radius:14px;overflow:hidden;
                  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <tr><td style="background:#2c2140;padding:20px 24px">
        <div style="color:#f8f2c2;font-size:20px;font-weight:700;letter-spacing:.3px">Rice &amp; Shine</div>
        <div style="color:#ada0be;font-size:13px;margin-top:2px">Sushi bake, made fresh</div>
      </td></tr>
      <tr><td style="padding:26px 24px 8px">
        <h1 style="margin:0 0 8px;font-size:22px;color:#251a38">Sign in to change your order</h1>
        <p style="margin:0;font-size:15px;line-height:1.55;color:#6f6280">
          ${name ? esc(name) + ", t" : "T"}his link opens your order so you can update it.
          It only works once, and only for this email address.
        </p>
      </td></tr>
      <tr><td style="padding:20px 24px 0">
        <a href="${esc(link)}"
           style="display:inline-block;background:#7a58ad;color:#ffffff;text-decoration:none;
                  font-size:15px;font-weight:600;padding:12px 22px;border-radius:8px">Open my order</a>
      </td></tr>
      <tr><td style="padding:20px 24px 26px">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#6f6280">
          If you didn't ask to change an order, you can ignore this email and
          nothing will happen. Questions? Message us on Instagram
          <strong style="color:#251a38">@${esc(IG)}</strong>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

    const text = [
      "Sign in to change your Rice & Shine order",
      "",
      `${name ? name + ", t" : "T"}his link opens your order so you can update it.`,
      "It only works once, and only for this email address.",
      "",
      link,
      "",
      "If you didn't ask to change an order, you can ignore this email.",
      `Questions? Message us on Instagram @${IG}`,
    ].join("\n");

    try {
      await sendEmail({
        to: email,
        subject: "Sign in to change your Rice & Shine order",
        html, text,
      });
    } catch (err) {
      logger.error("Sign-in email failed", { err: String(err) });
      throw new HttpsError("internal", "Could not send the sign-in email.");
    }
    return { ok: true };
  }
);
