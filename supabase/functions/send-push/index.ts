import { corsHeaders } from "../_shared/cors.ts";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "Carpool Crew <rides@carpoolcrew.co>";
const RESEND_REPLY_TO = Deno.env.get("RESEND_REPLY_TO");
const APP_URL = Deno.env.get("APP_URL");

let vapidInitialized = false;

function ensureVapid(): void {
  if (vapidInitialized) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys not configured");
  }
  webpush.setVapidDetails(
    "mailto:noreply@carpoolcrew.co",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
  vapidInitialized = true;
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonResponse(data: Record<string, unknown>) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function supaFetch(
  table: string,
  select: string,
  filters: Record<string, string> | Array<[string, string]>,
) {
  const params = new URLSearchParams({ select });
  const entries = Array.isArray(filters) ? filters : Object.entries(filters);
  for (const [k, v] of entries) params.append(k, v);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      "apikey": SERVICE_ROLE_KEY!,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return res.json();
}

async function supaDelete(table: string, filters: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) params.append(k, v);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
      method: "DELETE",
      headers: {
        "apikey": SERVICE_ROLE_KEY!,
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    console.error("[send-push] Failed to delete stale subscription:", e);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Skip test/seed/demo addresses — any email ending in "kidpool" is a non-deliverable test address.
function isTestEmail(email: string): boolean {
  return email.endsWith("kidpool");
}

// Send a push notification + email to a single profile. Used by the inline
// notification types (deadline_reminder, confirmation_reminder, assignment_request)
// that handle their own recipient logic and return early before the main loop.
async function sendEmailAndPush(
  profileId: string,
  notifTitle: string,
  notifBody: string,
  idempotencyKey: string,
  pushTag: string,
): Promise<void> {
  // Push notification
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    ensureVapid();
    const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${profileId}` });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
          JSON.stringify({ title: notifTitle, body: notifBody, tag: pushTag, url: "/" }),
          { TTL: 86400 },
        );
      } catch (error: any) {
        const statusCode = error?.statusCode ?? 0;
        if (statusCode === 410 || statusCode === 404) {
          await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
        }
      }
    }
  }

  // Email
  if (RESEND_API_KEY) {
    const profiles = await supaFetch("profiles", "email", { id: `eq.${profileId}` });
    const profile = profiles[0];
    if (profile?.email && !isTestEmail(profile.email)) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: profile.email,
            reply_to: RESEND_REPLY_TO,
            subject: notifTitle,
            html: `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;"><h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1><p style="font-size:15px;color:#0c2b52;line-height:1.5;">${escapeHtml(notifBody)}</p><p style="margin-top:24px;"><a href="https://carpoolcrew.co" style="display:inline-block;background:#118b8c;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-size:15px;">Open the app</a></p></body></html>`,
            text: notifBody,
          }),
        });
      } catch (e) {
        console.error(`[send-push] Email to ${profile.email} failed:`, e);
      }
    }
  }
}

// Format a Postgres time string ("08:40:00" or "17:15") as "8:40 AM".
function formatTime(t: string): string {
  const [h, m] = t.split(":");
  const hour = parseInt(h, 10);
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${m} ${ampm}`;
}

// Normalize a phone string to (XXX) XXX-XXXX. Handles leading +1 country
// code, common punctuation, and short/invalid inputs (returns the raw
// string if it can't be parsed to 10 digits).
function formatPhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
  if (digits.length !== 10) return raw;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

// Add minutes to a Postgres time string ("08:40" -> "09:10" for +30).
// Wraps past midnight. Returns "HH:MM" (zero-padded).
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map((n) => parseInt(n, 10));
  const total = h * 60 + m + minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const nh = Math.floor(wrapped / 60);
  const nm = wrapped % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

// Format a date+time as an ICS local datetime: "20260814T082500".
function toIcsLocal(dateStr: string, timeStr: string): string {
  return `${dateStr.replaceAll("-", "")}T${timeStr.replaceAll(":", "")}00`;
}

// Pacific-time parts for the current instant. `hour12: false` yields 00-23.
function pacificParts(now: Date, withMinute = false): Record<string, string> {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  };
  if (withMinute) opts.minute = "2-digit";
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", opts).formatToParts(now).map((p) => [p.type, p.value]),
  );
}

async function verifyAuth(authHeader: string): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const token = authHeader.replace("Bearer ", "");

  // Cron secret (from pg_cron via vault) — accept directly
  if (CRON_SECRET && token === CRON_SECRET) return true;

  // Service role key — accept directly
  if (SERVICE_ROLE_KEY && token === SERVICE_ROLE_KEY) return true;

  // User JWT — verify via Supabase auth API
  if (!ANON_KEY) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { "Authorization": `Bearer ${token}`, "apikey": ANON_KEY },
    });
    return res.ok;
  } catch (e) {
    console.error("[send-push] Auth verification failed (network error):", e);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonError("Missing auth header", 401);

  const isAuthed = await verifyAuth(authHeader);
  if (!isAuthed) return jsonError("Unauthorized", 401);

  try {
    const body = await req.json();
    const { type, assignment_id, version_id, displaced_drivers, nonce, test_date, test_status } = body;

    if (!SERVICE_ROLE_KEY) return jsonError("Service role key not configured", 500);
    if (!type) return jsonError("Missing notification type", 400);

    // ── welcome: email-only, no push, no profile lookup ─────
    // Triggered by the on_auth_user_welcome_email DB trigger on new signup.
    // The email address and name come directly from the request body
    // (sourced from auth.users by the trigger), so no DB lookup is needed.
    if (type === "welcome") {
      const email: string | undefined = body.email;
      const fullName: string | undefined = body.full_name;
      const userId: string | undefined = body.user_id;
      if (!email) return jsonError("Missing email for welcome", 400);
      if (!userId) return jsonError("Missing user_id for welcome", 400);
      if (isTestEmail(email)) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true });
      }
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      const firstName = (fullName ?? "there").split(" ")[0];
      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";
      const htmlBody =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
        `<h1 style="font-size:22px;margin:0 0 16px;">Welcome to Carpool Crew, ${escapeHtml(firstName)}</h1>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 24px;">Carpool Crew coordinates shared rides to Presidio Middle School for Clarendon families. Here's what to know to get started.</p>` +

        `<h2 style="font-size:16px;margin:24px 0 8px;">1. The three tabs</h2>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>Home</strong> — Your week at a glance: drives you're assigned, alerts if a ride is cancelled, and a quick link to the parent directory.</p>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>This Week</strong> — The published schedule, day by day. Tap any drive to see who's in the car.</p>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>Next Week</strong> — Where you check in for next week's rides (see below). Tap <strong>Earlier</strong> or <strong>Later</strong> to browse other weeks.</p>` +

        `<h2 style="font-size:16px;margin:24px 0 8px;">2. Check in by Saturday midnight</h2>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Every week, open the <strong>Next Week</strong> tab and tell us which days your child needs rides and which days you can drive. Submit by <strong>Saturday midnight Pacific</strong> — the scheduler builds the week's carpool from your check-in. Missed check-ins mean your child might not get a ride. You can reopen your check-in any time before the schedule is published.</p>` +

        `<h2 style="font-size:16px;margin:24px 0 8px;">3. Set your standard week</h2>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">You set this during setup. It pre-fills your weekly check-in with your family's typical ride needs and driving availability, so you only need to adjust for the unusual days. To change it later, tap your avatar, then edit the <strong>Standard week</strong> section. Morning pickup is 8:40 AM from Midtown Terrace; afternoon pickup is 5:15 PM from Presidio.</p>` +
        `<div style="background:#f0f9f9;border-left:4px solid #118b8c;padding:12px 16px;margin:16px 0;border-radius:4px;">` +
        `<p style="font-size:15px;line-height:1.6;margin:0;"><strong>Setting a standard week does not check you in automatically.</strong> You still need to open the Next Week tab and tap Submit each week.</p>` +
        `</div>` +

        `<h2 style="font-size:16px;margin:24px 0 8px;">4. Install the app on your phone</h2>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 8px;"><strong>iPhone:</strong> Open carpoolcrew.co in Safari, tap the Share button, then <strong>Add to Home Screen</strong>. Launch from the home screen icon to get push notifications when your child's drive changes.</p>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>Android:</strong> Open carpoolcrew.co in Chrome, tap the menu (three dots), then <strong>Add to Home Screen</strong> or <strong>Install app</strong>. Allow notifications when prompted.</p>` +

        `<p style="font-size:13px;line-height:1.5;color:#4f6278;margin-top:32px;border-top:1px solid #e0e0e0;padding-top:16px;">Questions? Reply to this email, or open the app and tap <strong>FAQ — How the carpool works</strong> on the Home tab.</p>` +
        `<p style="margin-top:24px;">${cta}</p>` +
        `</body></html>`;

      const textBody =
        `Welcome to Carpool Crew, ${firstName}!\n\n` +
        `Carpool Crew coordinates shared rides to Presidio Middle School for Clarendon families. Here's what to know to get started.\n\n` +
        `1. THE THREE TABS\n` +
        `Home: Your week at a glance — drives, alerts, parent directory.\n` +
        `This Week: The published schedule, day by day.\n` +
        `Next Week: Where you check in for next week's rides.\n\n` +
        `2. CHECK IN BY SATURDAY 3 PM\n` +
        `Every week, open the Next Week tab and tell us which days your child needs rides and which days you can drive. Submit by Saturday midnight Pacific.\n\n` +
        `3. SET YOUR STANDARD WEEK\n` +
        `Your standard week defaults pre-fill your weekly check-in — but they don't check you in automatically. You still need to open the Next Week tab and tap Submit each week. Edit your standard week any time from the Account screen (tap your avatar).\n\n` +
        `4. INSTALL THE APP\n` +
        `iPhone: Open carpoolcrew.co in Safari, tap Share, then Add to Home Screen.\n` +
        `Android: Open carpoolcrew.co in Chrome, tap menu, then Add to Home Screen.\n\n` +
        `Questions? Reply to this email, or open the app and tap FAQ on the Home tab.`;

      const idempotencyKey = `welcome-${userId}`;
      let emailSent = 0;
      let emailFailed = 0;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: email,
            reply_to: RESEND_REPLY_TO,
            subject: "Welcome to Carpool Crew",
            html: htmlBody,
            text: textBody,
            tags: [
              { name: "type", value: "welcome" },
              { name: "group", value: "unknown" },
            ],
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          console.error(`[send-push] Welcome email to ${email} failed:`, err);
          emailFailed++;
        } else {
          emailSent++;
        }
      } catch (e) {
        console.error(`[send-push] Welcome email to ${email} threw:`, e);
        emailFailed++;
      }
      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── no_rides_requested: "did you mean to request rides?" email ──
    // Triggered by a DB trigger on weekly_checkins when a parent submits
    // a check-in with zero ride_requests (needs_ride=true) for their active
    // children. The trigger passes only checkin_id; this function fetches
    // the checkin, household, children, week, and submitter profile to
    // build a personalized email. Idempotency key: no-rides-${checkin_id}.
    if (type === "no_rides_requested") {
      const checkinId: string | undefined = body.checkin_id;
      if (!checkinId) return jsonError("Missing checkin_id", 400);
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      // Fetch the checkin row.
      const checkinRows = await supaFetch("weekly_checkins", "id,household_id,submitted_by,week_id,group_id", { id: `eq.${checkinId}` });
      if (checkinRows.length === 0) return jsonError("Checkin not found", 404);
      const checkin = checkinRows[0];
      const groupId = checkin.group_id;

      // Defensive re-verify: check for active children with needs_ride=true.
      // Prevents a stale/racing trigger from spamming.
      const rideRequests = await supaFetch("ride_requests", "id", { checkin_id: `eq.${checkinId}`, needs_ride: "eq.true" });
      const activeChildren = await supaFetch("children", "id,first_name,last_name", { household_id: `eq.${checkin.household_id}`, group_id: `eq.${groupId}`, active: "eq.true" });
      if (rideRequests.length > 0 || activeChildren.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "has_rides_or_no_children" });
      }

      // Fetch submitter profile for name + email.
      const profiles = await supaFetch("profiles", "id,full_name,email", { id: `eq.${checkin.submitted_by}` });
      if (profiles.length === 0) return jsonError("Submitter profile not found", 404);
      const profile = profiles[0];
      if (isTestEmail(profile.email)) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true });
      }

      // Fetch week date.
      const weekRows = await supaFetch("weeks", "starts_on", { id: `eq.${checkin.week_id}` });
      const weekDate = weekRows.length > 0
        ? new Date(weekRows[0].starts_on + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })
        : "next week";

      // Personalize.
      const firstName = (profile.full_name ?? "there").split(" ")[0];
      const childNames = activeChildren.map((c: any) => c.first_name).join(", ");
      const childLabel = activeChildren.length === 1 ? childNames : "your children";
      const cta = APP_URL
        ? `<p style="margin:24px 0 0;"><a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:#118b8c;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Open the app</a></p>`
        : "";

      const htmlBody = `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">
<h1 style="font-size:22px;margin:0 0 16px;">Did you mean to request rides?</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">We noticed you submitted your check-in for the week of ${escapeHtml(weekDate)}, but didn't request any rides for ${escapeHtml(childLabel)}.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">If that was intentional — maybe they're not riding that week — no action needed.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">If it was an oversight:</p>
<ol style="font-size:15px;line-height:1.6;margin:0 0 16px;padding-left:20px;">
<li>Open the <strong>Next Week</strong> tab</li>
<li>Scroll to the bottom and tap <strong>Reopen to change ride needs</strong></li>
<li>Tap each day your child needs a ride (morning and/or afternoon)</li>
<li>Tap <strong>Submit</strong> again</li>
</ol>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Questions? Reply to this email or check the FAQ in the app.</p>
${cta}
</body></html>`;

      const textBody = `Did you mean to request rides?

Hi ${firstName},

We noticed you submitted your check-in for the week of ${weekDate}, but didn't request any rides for ${childLabel}.

If that was intentional — maybe they're not riding that week — no action needed.

If it was an oversight:
1. Open the "Next Week" tab
2. Scroll to the bottom and tap "Reopen to change ride needs"
3. Tap each day your child needs a ride (morning and/or afternoon)
4. Tap "Submit" again

Questions? Reply to this email or check the FAQ in the app.`;

      let emailSent = 0;
      let emailFailed = 0;
      try {
        const resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": `no-rides-${checkinId}`,
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: profile.email,
            reply_to: RESEND_REPLY_TO || undefined,
            subject: "Did you mean to request rides for next week?",
            html: htmlBody,
            text: textBody,
            tags: [
              { name: "type", value: "no_rides_requested" },
              { name: "group", value: groupId },
            ],
          }),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          console.error("[send-push] no_rides_requested email failed:", errText);
          emailFailed++;
        } else {
          emailSent++;
        }
      } catch (e) {
        console.error(`[send-push] no_rides_requested email to ${profile.email} threw:`, e);
        emailFailed++;
      }
      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── broadcast: one-off email to all active members ─────────
    // Reusable type for sending arbitrary content to the whole group.
    // Request body: { type, broadcast_id, subject, html_body, text_body }
    // Recipients: all active memberships in the pilot group.
    // Idempotency key: broadcast-${broadcast_id}-${profile.id} — re-runs dedupe.
    if (type === "broadcast") {
      const broadcastId: string | undefined = body.broadcast_id;
      const subject: string | undefined = body.subject;
      const htmlBodyParam: string | undefined = body.html_body;
      const textBodyParam: string | undefined = body.text_body;
      const filterEmail: string | undefined = body.filter_email;

      if (!broadcastId) return jsonError("Missing broadcast_id", 400);
      if (!subject) return jsonError("Missing subject", 400);
      if (!htmlBodyParam) return jsonError("Missing html_body", 400);

      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      // Pilot group
      const groupId = "c1000000-0000-4000-8000-000000000001";
      const memberships = await supaFetch("memberships", "profile_id", { group_id: `eq.${groupId}`, status: "eq.active" });
      const recipientProfileIds = [...new Set(memberships.map((m: any) => m.profile_id))];
      if (recipientProfileIds.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_recipients" });
      }

      const profileIdsStr = `(${recipientProfileIds.join(",")})`;
      const profiles = await supaFetch("profiles", "id,email", { id: `in.${profileIdsStr}` });

      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";

      // Wrap the provided html_body in the standard email shell + append CTA
      const fullHtml =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
        `${htmlBodyParam}` +
        `<p style="margin-top:24px;">${cta}</p>` +
        `</body></html>`;

      let emailSent = 0;
      let emailFailed = 0;
      let pushSent = 0;
      let pushFailed = 0;
      let lastPushError = "";
      let skipped = 0;

      // Initialize VAPID for push (if keys are configured)
      if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
        ensureVapid();
      }

      for (const profile of profiles) {
        if (!profile.email) continue;
        if (isTestEmail(profile.email)) continue;
        if (filterEmail && profile.email !== filterEmail) continue;

        // ── Email ──
        const idempotencyKey = `broadcast-${broadcastId}-${profile.id}`;
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: profile.email,
              reply_to: RESEND_REPLY_TO,
              subject,
              html: fullHtml,
              text: textBodyParam ?? "",
              tags: [
                { name: "type", value: "broadcast" },
                { name: "group", value: groupId },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error(`[send-push] Broadcast email to ${profile.email} failed:`, err);
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] Broadcast email to ${profile.email} threw:`, e);
          emailFailed++;
        }

        // ── Push notification ──
        if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
          const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${profile.id}` });
          for (const sub of subs) {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
                JSON.stringify({ title: subject, body: textBodyParam ?? subject, tag: `broadcast-${broadcastId}`, url: "/" }),
                { TTL: 86400 },
              );
              pushSent++;
            } catch (error: any) {
              pushFailed++;
              lastPushError = `${error?.statusCode ?? "?"}: ${error?.message ?? String(error)}`;
              console.error(`[send-push] Broadcast push to ${profile.id} failed:`, lastPushError);
              const statusCode = error?.statusCode ?? 0;
              if (statusCode === 410 || statusCode === 404) {
                await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
              }
            }
          }
        }
      }

      return jsonResponse({ sent: pushSent, failed: pushFailed, email_sent: emailSent, email_failed: emailFailed, skipped, push_enabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), push_error: pushFailed > 0 ? lastPushError : undefined });
    }

    // ── coordinator_tentative_summary: Sunday morning email to coordinators ──
    // Triggered by a fixed cron at Sunday 7 AM Pacific (DST-proofed dual UTC:
    // 0 14,15 * * 0). Sends the coordinator the tentative weekly schedule
    // with a clear call-to-action: parents must confirm their drives by
    // Sunday 7 PM Pacific (the confirmation_deadline). Email-only (no push).
    // Recipients: active coordinators for the group. Idempotency key includes
    // the week ID and today's Pacific date so a DST off-fire dedupes via Resend.
    if (type === "coordinator_tentative_summary") {
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      const now = new Date();
      const parts = pacificParts(now, false);
      // Today's Pacific date (YYYY-MM-DD) — used for idempotency
      const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
      // Find the upcoming week: starts_on > today (Pacific), has trips.
      // The draft is generated Saturday 3 PM Pacific (or Sunday 7 AM on the
      // cadence-overhaul branch); by Sunday 7 AM the draft always exists.
      const pilotGroupId = "c1000000-0000-4000-8000-000000000001";
      const upcomingWeeks = await supaFetch(
        "weeks",
        "id,group_id,starts_on,confirmation_deadline",
        { group_id: `eq.${pilotGroupId}`, starts_on: `gt.${todayStr}` },
      );
      if (upcomingWeeks.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_upcoming_week" });
      }
      // Take the earliest upcoming week
      const week = upcomingWeeks.sort((a: any, b: any) => a.starts_on.localeCompare(b.starts_on))[0];
      const weekId = week.id;
      const groupId = week.group_id;
      const weekStartDate = week.starts_on;

      // Load the draft schedule version (not published — it's tentative)
      const versions = await supaFetch("schedule_versions", "id", {
        week_id: `eq.${weekId}`,
        group_id: `eq.${groupId}`,
        status: "eq.draft",
      });
      if (versions.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_draft_version" });
      }
      const versionId = versions[0].id;

      // Load trips for this week
      const trips = await supaFetch(
        "trips",
        "id,service_date,direction,meeting_time,origin,destination",
        { week_id: `eq.${weekId}`, group_id: `eq.${groupId}` },
      );
      const tripIds = trips.map((t: any) => t.id);
      if (tripIds.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_trips" });
      }

      // Load driver assignments (tentative + confirmed) and rider assignments
      const driverAssignments = await supaFetch(
        "driver_assignments",
        "id,trip_id,driver_profile_id,vehicle_id,status,child_passenger_capacity",
        { schedule_version_id: `eq.${versionId}`, trip_id: `in.(${tripIds.join(",")})` },
      );
      const daIds = driverAssignments.map((da: any) => da.id);
      let riderAssignments: any[] = [];
      if (daIds.length > 0) {
        riderAssignments = await supaFetch("rider_assignments", "child_id,driver_assignment_id", {
          driver_assignment_id: `in.(${daIds.join(",")})`,
        });
      }

      // Fetch children, driver profiles, vehicles
      const childIds = [...new Set(riderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0
        ? await supaFetch("children", "id,first_name,last_name,household_id", { id: `in.(${childIds.join(",")})` })
        : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      const driverProfileIds = [...new Set(driverAssignments.map((da: any) => da.driver_profile_id))];
      const driverProfiles = driverProfileIds.length > 0
        ? await supaFetch("profiles", "id,full_name", { id: `in.(${driverProfileIds.join(",")})` })
        : [];
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const vehicleIds = [...new Set(driverAssignments.map((da: any) => da.vehicle_id).filter(Boolean))];
      const vehicles = vehicleIds.length > 0
        ? await supaFetch("vehicles", "id,label", { id: `in.(${vehicleIds.join(",")})` })
        : [];
      const vehicleMap = new Map(vehicles.map((v: any) => [v.id, v]));

      // Build per-driver-assignment kid lists
      const tripRidersByDriver = new Map<string, string[]>();
      for (const ra of riderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = `${child.first_name} ${child.last_name}`.trim();
        const arr = tripRidersByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push(kidName);
        tripRidersByDriver.set(ra.driver_assignment_id, arr);
      }

      // Group trips by date, then morning/afternoon
      const tripsById = new Map(trips.map((t: any) => [t.id, t]));
      const tripsByDate = new Map<string, any[]>();
      for (const trip of trips) {
        const arr = tripsByDate.get(trip.service_date) ?? [];
        arr.push(trip);
        tripsByDate.set(trip.service_date, arr);
      }
      const sortedDates = [...tripsByDate.keys()].sort();

      // Format the confirmation deadline for the email copy
      const deadlineDate = new Date(week.confirmation_deadline);
      const deadlineParts = pacificParts(deadlineDate, true);
      const deadlineStr = `${parseInt(deadlineParts.month, 10)}/${parseInt(deadlineParts.day, 10)}`;
      const deadlineHour = parseInt(deadlineParts.hour, 10);
      const deadlineMinute = parseInt(deadlineParts.minute, 10);
      const deadlineAmpm = deadlineHour >= 12 ? "PM" : "AM";
      const deadlineHour12 = deadlineHour % 12 === 0 ? 12 : deadlineHour % 12;
      const deadlineTimeStr = deadlineMinute === 0
        ? `${deadlineHour12} ${deadlineAmpm}`
        : `${deadlineHour12}:${String(deadlineMinute).padStart(2, "0")} ${deadlineAmpm}`;

      // Build roster HTML and text — per day, morning + afternoon
      const rosterHtmlLines: string[] = [];
      const rosterTextLines: string[] = [];
      const allAssignedTrips = new Set(driverAssignments.map((da: any) => da.trip_id));

      for (const date of sortedDates) {
        const dayTrips = tripsByDate.get(date) ?? [];
        const dayLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        rosterHtmlLines.push(`<h2 style="font-size:16px;margin:20px 0 8px;color:#0c2b52;">${escapeHtml(dayLabel)}</h2>`);
        rosterTextLines.push(`\n${dayLabel}`);

        for (const direction of ["morning", "afternoon"] as const) {
          const trip = dayTrips.find((t: any) => t.direction === direction);
          if (!trip) continue;
          const time = formatTime(trip.meeting_time);
          const dirLabel = direction === "morning" ? "Morning" : "Afternoon";
          const tripDrivers = driverAssignments.filter((da: any) => da.trip_id === trip.id);

          rosterHtmlLines.push(`<p style="font-size:14px;margin:4px 0 2px;font-weight:600;color:#118b8c;">${dirLabel} (${time})</p>`);
          rosterTextLines.push(`  ${dirLabel} (${time})`);

          if (tripDrivers.length === 0) {
            // No driver — flag as uncovered
            rosterHtmlLines.push(`<p style="font-size:14px;margin:0 0 8px;padding:8px 12px;background:#fef2f2;border-radius:6px;color:#b91c1c;">⚠️ No driver — trip is uncovered</p>`);
            rosterTextLines.push(`    ⚠️ No driver — trip is uncovered`);
          } else {
            for (const da of tripDrivers) {
              const driver = driverProfileMap.get(da.driver_profile_id);
              const vehicle = vehicleMap.get(da.vehicle_id);
              const kids = tripRidersByDriver.get(da.id) ?? [];
              const statusIcon = da.status === "confirmed" ? "✅" : "⏳";
              const statusLabel = da.status === "confirmed" ? "confirmed" : "tentative";
              const driverName = driver?.full_name ?? "A driver";
              const vehicleStr = vehicle?.label ? ` (${vehicle.label})` : "";
              const kidsStr = kids.length > 0 ? ` — ${kids.join(", ")}` : "";
              rosterHtmlLines.push(`<p style="font-size:14px;margin:0 0 4px;">${statusIcon} <strong>${escapeHtml(driverName)}</strong>${escapeHtml(vehicleStr)} <span style="color:#64748b;font-size:12px;">(${statusLabel})</span><br><span style="color:#475569;">${escapeHtml(kidsStr)}</span></p>`);
              rosterTextLines.push(`    ${statusIcon} ${driverName}${vehicleStr} (${statusLabel})${kidsStr}`);
            }
            rosterTextLines.push("");
          }
        }
      }

      // Check for households that haven't submitted check-ins
      const checkins = await supaFetch("weekly_checkins", "household_id,status", {
        week_id: `eq.${weekId}`,
        group_id: `eq.${groupId}`,
      });
      const draftHouseholds = checkins.filter((c: any) => c.status === "draft").map((c: any) => c.household_id);
      let pendingCheckinHtml = "";
      let pendingCheckinText = "";
      if (draftHouseholds.length > 0) {
        const householdIdsStr = `(${draftHouseholds.join(",")})`;
        const households = await supaFetch("households", "id,name", { id: `in.${householdIdsStr}` });
        const householdMap = new Map(households.map((h: any) => [h.id, h.name]));
        const pendingNames = draftHouseholds.map((hid: string) => householdMap.get(hid) ?? "Unknown").filter(Boolean);
        pendingCheckinHtml = `<div style="margin-top:20px;padding:12px;background:#fffbeb;border-radius:6px;"><p style="font-size:14px;margin:0;color:#92400e;"><strong>${pendingNames.length} household${pendingNames.length !== 1 ? "s" : ""} still checking in:</strong> ${pendingNames.map(escapeHtml).join(", ")}</p></div>`;
        pendingCheckinText = `\n\n${pendingNames.length} household(s) still checking in: ${pendingNames.join(", ")}`;
      }

      // Recipients: all active members
      const memberships = await supaFetch("memberships", "profile_id", {
        group_id: `eq.${groupId}`,
        status: "eq.active",
      });
      const recipientProfileIds = memberships.map((m: any) => m.profile_id);
      if (recipientProfileIds.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_recipients" });
      }
      const recipientProfiles = await supaFetch("profiles", "id,full_name,email", {
        id: `in.(${recipientProfileIds.join(",")})`,
      });

      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";

      let emailSent = 0;
      let emailFailed = 0;
      const rosterHtml = rosterHtmlLines.join("");
      const rosterText = rosterTextLines.join("\n");

      for (const profile of recipientProfiles) {
        if (!profile.email || isTestEmail(profile.email)) continue;
        const firstName = (profile.full_name ?? "coordinator").split(" ")[0];

        const htmlBody =
          `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
          `<h1 style="font-size:22px;margin:0 0 8px;">Tentative schedule for the week of ${escapeHtml(new Date(weekStartDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" }))}</h1>` +
`<p style="font-size:15px;margin:0 0 16px;">Hi ${escapeHtml(firstName)}, here's the tentative carpool schedule.</p>` +
          `<div style="background:#fef9c3;padding:12px 16px;border-radius:8px;margin:0 0 16px;border-left:4px solid #eab308;"><p style="font-size:15px;margin:0;color:#0c2b52;"><strong>&#9888; Parents must confirm their drives by Sunday ${escapeHtml(deadlineStr)} at ${escapeHtml(deadlineTimeStr)} Pacific.</strong></p></div>` +
          `<p style="margin:0 0 20px;">${cta}</p>` +
          `<div style="background:#f0f9f9;padding:12px;border-radius:8px;margin:0 0 16px;"><p style="font-size:13px;margin:0;color:#0c2b52;"><strong>&#9201; = tentative</strong> (parent hasn't confirmed yet) &nbsp;&nbsp; <strong>&#9989; = confirmed</strong></p></div>` +
          rosterHtml +
          pendingCheckinHtml +
          `<p style="margin-top:24px;">${cta}</p>` +
          `</body></html>`;

        const textBody =
          `Tentative schedule for the week of ${new Date(weekStartDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })}\n\n` +
`Hi ${firstName}, here's the tentative carpool schedule.\n\n` +
          `\u26A0 Parents must confirm their drives by Sunday ${deadlineStr} at ${deadlineTimeStr} Pacific.\n\n` +
          `⏳ = tentative (parent hasn't confirmed yet)  ✅ = confirmed\n` +
          rosterText +
          pendingCheckinText + "\n";

        const idempotencySuffix = nonce ? `-${nonce}` : "";
        const idempotencyKey = `coordinator-tentative-${weekId}-${todayStr}-${profile.id}${idempotencySuffix}`;
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: profile.email,
              reply_to: RESEND_REPLY_TO,
              subject: `Tentative schedule for the week of ${new Date(weekStartDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })}`,
              html: htmlBody,
              text: textBody,
              tags: [
                { name: "type", value: "coordinator_tentative_summary" },
                { name: "group", value: groupId ?? "unknown" },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error(`[send-push] Coordinator tentative summary email to ${profile.email} failed:`, err);
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] Coordinator tentative summary email to ${profile.email} threw:`, e);
          emailFailed++;
        }
      }

      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed, reason: "coordinator_tentative_summary" });
    }

    // ── night_before_summary: "who's driving tomorrow" email + push ──
    // Triggered by a fixed cron at 7:45 PM Pacific (Sun-Thu nights).
    // No time gate — the cron fires at the right time. DST-proofed via
    // dual UTC (45 2,3 * * 0-4); off-DST fire deduped by idempotency key.
    // Recipients are families with a child riding tomorrow (via
    // rider_assignments on the published schedule). Each notification is
    // personalized — the recipient's own driving status + full driver roster.
    // Sends both email (full roster) and push (personal section only).
    if (type === "night_before_summary") {
      const now = new Date();
      const parts = pacificParts(now, false);

      // Tomorrow's Pacific date (YYYY-MM-DD)
      const todayDate = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
      todayDate.setUTCDate(todayDate.getUTCDate() + 1);
      const tomorrow = todayDate.toISOString().slice(0, 10);

      // Find trips for tomorrow (morning + afternoon)
      const trips = await supaFetch("trips", "id,service_date,direction,meeting_time,origin,destination,week_id,group_id", { service_date: `eq.${tomorrow}` });
      if (trips.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_school_tomorrow" });
      }
      const groupId = trips[0].group_id;

      // Find the published schedule version for each week, fetch confirmed
      // driver assignments + rider assignments for tomorrow's trips.
      const weekIds = [...new Set(trips.map((t: any) => t.week_id))];
      let allDriverAssignments: any[] = [];
      let allRiderAssignments: any[] = [];
      for (const weekId of weekIds) {
        const versions = await supaFetch("schedule_versions", "id", { week_id: `eq.${weekId}`, group_id: `eq.${groupId}`, status: "eq.published" });
        if (versions.length === 0) continue;
        const versionId = versions[0].id;
        const tripIds = trips.filter((t: any) => t.week_id === weekId).map((t: any) => t.id);
        const das = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,vehicle_id", {
          schedule_version_id: `eq.${versionId}`,
          trip_id: `in.(${tripIds.join(",")})`,
          group_id: `eq.${groupId}`,
          status: "eq.confirmed",
        });
        allDriverAssignments.push(...das);
        if (das.length > 0) {
          const daIds = das.map((da: any) => da.id);
          const ras = await supaFetch("rider_assignments", "child_id,driver_assignment_id", {
            driver_assignment_id: `in.(${daIds.join(",")})`,
          });
          allRiderAssignments.push(...ras);
        }
      }

      if (allDriverAssignments.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_confirmed_drivers" });
      }

      // Fetch children, driver profiles, vehicles
      const childIds = [...new Set(allRiderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0 ? await supaFetch("children", "id,first_name,last_name,household_id", { id: `in.(${childIds.join(",")})` }) : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      const driverProfileIds = [...new Set(allDriverAssignments.map((da: any) => da.driver_profile_id))];
      const driverProfiles = await supaFetch("profiles", "id,full_name,email", { id: `in.(${driverProfileIds.join(",")})` });
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const vehicleIds = [...new Set(allDriverAssignments.map((da: any) => da.vehicle_id).filter(Boolean))];
      const vehicles = vehicleIds.length > 0 ? await supaFetch("vehicles", "id,label", { id: `in.(${vehicleIds.join(",")})` }) : [];
      const vehicleMap = new Map(vehicles.map((v: any) => [v.id, v]));

      // Build per-driver-assignment kid lists and per-trip driver rosters
      const tripsById = new Map(trips.map((t: any) => [t.id, t]));
      const tripRidersByDriver = new Map<string, string[]>();
      for (const ra of allRiderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = `${child.first_name} ${child.last_name}`.trim();
        const arr = tripRidersByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push(kidName);
        tripRidersByDriver.set(ra.driver_assignment_id, arr);
      }
      const tripDriversMap = new Map<string, { driverName: string; vehicleLabel: string; kids: string[] }[]>();
      for (const da of allDriverAssignments) {
        const trip = tripsById.get(da.trip_id);
        if (!trip) continue;
        const driver = driverProfileMap.get(da.driver_profile_id);
        const vehicle = vehicleMap.get(da.vehicle_id);
        const kids = tripRidersByDriver.get(da.id) ?? [];
        const entry = { driverName: driver?.full_name ?? "A driver", vehicleLabel: vehicle?.label ?? "", kids };
        const arr = tripDriversMap.get(da.trip_id) ?? [];
        arr.push(entry);
        tripDriversMap.set(da.trip_id, arr);
      }

      // Build roster text (morning then afternoon)
      const rosterLines: string[] = [];
      for (const direction of ["morning", "afternoon"] as const) {
        const dirTrips = trips.filter((t: any) => t.direction === direction);
        if (dirTrips.length === 0) continue;
        const drivers = dirTrips.flatMap((t: any) => tripDriversMap.get(t.id) ?? []);
        if (drivers.length === 0) continue;
        const label = direction === "morning" ? "Morning" : "Afternoon";
        const time = formatTime(dirTrips[0].meeting_time);
        const origin = dirTrips[0].origin;
        const driverLines = drivers.map((d) => {
          const kidsStr = d.kids.length > 0 ? ` — ${d.kids.join(", ")}` : "";
          const vehicleStr = d.vehicleLabel ? ` (${d.vehicleLabel})` : "";
          return `${d.driverName}${vehicleStr}${kidsStr}`;
        });
        rosterLines.push(`${label} (${time} from ${origin}): ${driverLines.join("; ")}`);
      }
      const rosterText = rosterLines.join("\n");

      // Recipients: families with a child riding tomorrow
      const ridingHouseholdIds = new Set<string>();
      for (const ra of allRiderAssignments) {
        const child = childMap.get(ra.child_id);
        if (child) ridingHouseholdIds.add(child.household_id);
      }
      const recipientProfileIds: string[] = [];
      for (const hid of ridingHouseholdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }
      if (recipientProfileIds.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_recipients" });
      }

      // Fetch recipient profiles
      const recipientProfiles = await supaFetch("profiles", "id,full_name,email", { id: `in.(${[...new Set(recipientProfileIds)].join(",")})` });

      // Map driver profile -> their drives tomorrow (for personalization)
      const driverProfileToTrips = new Map<string, { direction: string; meetingTime: string; origin: string; kids: string[] }[]>();
      for (const da of allDriverAssignments) {
        const trip = tripsById.get(da.trip_id);
        if (!trip) continue;
        const kids = tripRidersByDriver.get(da.id) ?? [];
        const entry = { direction: trip.direction, meetingTime: trip.meeting_time, origin: trip.origin, kids };
        const arr = driverProfileToTrips.get(da.driver_profile_id) ?? [];
        arr.push(entry);
        driverProfileToTrips.set(da.driver_profile_id, arr);
      }

      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";

      let emailSent = 0;
      let emailFailed = 0;
      let pushSent = 0;
      let pushFailed = 0;

      if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
        ensureVapid();
      }

      for (const profile of recipientProfiles) {
        if (!profile.email) continue;
        if (isTestEmail(profile.email)) continue;

        const firstName = (profile.full_name ?? "there").split(" ")[0];
        const myDrives = driverProfileToTrips.get(profile.id) ?? [];

        let personalSection: string;
        if (myDrives.length > 0) {
          personalSection = myDrives.map((d) => {
            const dirLabel = d.direction === "morning" ? "morning" : "afternoon";
            const time = formatTime(d.meetingTime);
            const kidsStr = d.kids.length > 0 ? ` Kids in your car: ${d.kids.join(", ")}.` : "";
            return `You're driving tomorrow ${dirLabel} — ${time} from ${d.origin}.${kidsStr}`;
          }).join("\n");
        } else {
          personalSection = "You're not driving tomorrow.";
        }

        const htmlBody =
          `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
          `<h1 style="font-size:22px;margin:0 0 16px;">Tomorrow's carpool, ${escapeHtml(firstName)}</h1>` +
          `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;white-space:pre-line;">${escapeHtml(personalSection)}</p>` +
          `<h2 style="font-size:16px;margin:24px 0 8px;">Tomorrow's drivers</h2>` +
          `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;white-space:pre-line;">${escapeHtml(rosterText)}</p>` +
          `<p style="margin-top:24px;">${cta}</p>` +
          `</body></html>`;

        const textBody =
          `Tomorrow's carpool, ${firstName}\n\n` +
          `${personalSection}\n\n` +
          `Tomorrow's drivers\n${rosterText}\n`;

        const idempotencyKey = `night-before-${tomorrow}-${profile.id}`;
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: profile.email,
              reply_to: RESEND_REPLY_TO,
              subject: "Tomorrow's carpool",
              html: htmlBody,
              text: textBody,
              tags: [
                { name: "type", value: "night_before_summary" },
                { name: "group", value: groupId ?? "unknown" },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error(`[send-push] Night-before email to ${profile.email} failed:`, err);
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] Night-before email to ${profile.email} threw:`, e);
          emailFailed++;
        }

        // Push notification (personal section only — full roster is in the email)
        if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
          const pushTag = `night-before-${tomorrow}-${profile.id}`;
          const pushPayload = JSON.stringify({
            title: "Tomorrow's carpool",
            body: personalSection,
            tag: pushTag,
            url: "/",
          });
          const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${profile.id}` });
          for (const sub of subs) {
            try {
              await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
                pushPayload,
                { TTL: 86400 },
              );
              pushSent++;
            } catch (error: any) {
              pushFailed++;
              const statusCode = error?.statusCode ?? 0;
              if (statusCode === 410 || statusCode === 404) {
                await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
              }
            }
          }
        }
      }

      return jsonResponse({ sent: pushSent, failed: pushFailed, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── backpack_sheet: morning-of per-child "backpack sheet" email ──
    // Triggered by a fixed cron at 7 AM Pacific on school days (Mon–Fri).
    // DST-proofed dual UTC (0 14,15 * * 1-5); off-DST fire deduped by
    // idempotency key. Sends each family with a child riding today a
    // per-child reference sheet: driver name + phone (always shown —
    // drive-scoped, overrides the directory share_phone opt-out), vehicle,
    // other kids in the car, and pickup time/origin for morning + afternoon.
    // Designed to be printed and put in the kid's backpack. Email-only.
    if (type === "backpack_sheet") {
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      const now = new Date();
      const parts = pacificParts(now, false);
      const today = test_date || `${parts.year}-${parts.month}-${parts.day}`;

      // Find today's trips (morning + afternoon)
      const trips = await supaFetch("trips", "id,service_date,direction,meeting_time,origin,destination,week_id,group_id", { service_date: `eq.${today}` });
      if (trips.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_school_today" });
      }
      const groupId = trips[0].group_id;

      // Find the published schedule version, load confirmed driver assignments.
      // test_status (manual trigger only) lets us test against a draft version.
      const versionStatus = test_status || "published";
      const driverStatus = test_status === "draft" ? "in.(tentative,confirmed)" : "eq.confirmed";
      const weekIds = [...new Set(trips.map((t: any) => t.week_id))];
      let allDriverAssignments: any[] = [];
      let allRiderAssignments: any[] = [];
      for (const weekId of weekIds) {
        const versions = await supaFetch("schedule_versions", "id", { week_id: `eq.${weekId}`, group_id: `eq.${groupId}`, status: `eq.${versionStatus}` });
        if (versions.length === 0) continue;
        const versionId = versions[0].id;
        const tripIds = trips.filter((t: any) => t.week_id === weekId).map((t: any) => t.id);
        const das = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,vehicle_id", {
          schedule_version_id: `eq.${versionId}`,
          trip_id: `in.(${tripIds.join(",")})`,
          group_id: `eq.${groupId}`,
          status: driverStatus,
        });
        allDriverAssignments.push(...das);
        if (das.length > 0) {
          const daIds = das.map((da: any) => da.id);
          const ras = await supaFetch("rider_assignments", "child_id,driver_assignment_id", {
            driver_assignment_id: `in.(${daIds.join(",")})`,
          });
          allRiderAssignments.push(...ras);
        }
      }

      if (allDriverAssignments.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_confirmed_drivers" });
      }

      // Fetch children (with phone for carmate contact), driver profiles (with phone), vehicles
      const childIds = [...new Set(allRiderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0 ? await supaFetch("children", "id,first_name,last_name,household_id,phone", { id: `in.(${childIds.join(",")})` }) : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      const driverProfileIds = [...new Set(allDriverAssignments.map((da: any) => da.driver_profile_id))];
      const driverProfiles = driverProfileIds.length > 0
        ? await supaFetch("profiles", "id,full_name,phone", { id: `in.(${driverProfileIds.join(",")})` })
        : [];
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const vehicleIds = [...new Set(allDriverAssignments.map((da: any) => da.vehicle_id).filter(Boolean))];
      const vehicles = vehicleIds.length > 0 ? await supaFetch("vehicles", "id,label", { id: `in.(${vehicleIds.join(",")})` }) : [];
      const vehicleMap = new Map(vehicles.map((v: any) => [v.id, v]));

      // Build per-driver-assignment kid lists with phone numbers
      const tripsById = new Map(trips.map((t: any) => [t.id, t]));
      const tripRidersByDriver = new Map<string, { name: string; phone: string | null }[]>();
      for (const ra of allRiderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = child.first_name.trim();
        const kidPhone = child.phone ?? null;
        const arr = tripRidersByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push({ name: kidName, phone: kidPhone });
        tripRidersByDriver.set(ra.driver_assignment_id, arr);
      }

      // Map: childId -> { morning, afternoon } trip info
      const childTripInfo = new Map<string, { morning: any; afternoon: any }>();
      for (const child of children) {
        childTripInfo.set(child.id, { morning: null, afternoon: null });
      }
      for (const da of allDriverAssignments) {
        const trip = tripsById.get(da.trip_id);
        if (!trip) continue;
        const driver = driverProfileMap.get(da.driver_profile_id);
        const vehicle = vehicleMap.get(da.vehicle_id);
        const kidsWithPhones = tripRidersByDriver.get(da.id) ?? [];
        const entry = {
          driverName: driver?.full_name ?? "A driver",
          driverPhone: driver?.phone ?? null,
          vehicleLabel: vehicle?.label ?? "",
          kidsWithPhones,
          meetingTime: trip.meeting_time,
          origin: trip.origin,
        };
        const riders = allRiderAssignments.filter((ra: any) => ra.driver_assignment_id === da.id);
        for (const ra of riders) {
          const info = childTripInfo.get(ra.child_id);
          if (!info) continue;
          if (trip.direction === "morning") info.morning = entry;
          else info.afternoon = entry;
        }
      }

      // Recipients: families with a child riding today
      const ridingHouseholdIds = new Set<string>();
      for (const ra of allRiderAssignments) {
        const child = childMap.get(ra.child_id);
        if (child) ridingHouseholdIds.add(child.household_id);
      }
      const recipientProfileIds: string[] = [];
      for (const hid of ridingHouseholdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }
      if (recipientProfileIds.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_recipients" });
      }

      // Fetch recipient profiles (need household_id to find their kids)
      const recipientProfiles = await supaFetch("profiles", "id,full_name,email", { id: `in.(${[...new Set(recipientProfileIds)].join(",")})` });
      // Map profile -> household_id via memberships
      const recipientMemberships = await supaFetch("memberships", "profile_id,household_id", {
        profile_id: `in.(${[...new Set(recipientProfileIds)].join(",")})`,
        status: "eq.active",
      });
      const profileToHousehold = new Map(recipientMemberships.map((m: any) => [m.profile_id, m.household_id]));
      // Map household_id -> children riding today
      const householdToRidingChildren = new Map<string, any[]>();
      for (const child of children) {
        const arr = householdToRidingChildren.get(child.household_id) ?? [];
        arr.push(child);
        householdToRidingChildren.set(child.household_id, arr);
      }

      const todayLabel = new Date(today + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

      let emailSent = 0;
      let emailFailed = 0;

      for (const profile of recipientProfiles) {
        if (!profile.email || isTestEmail(profile.email)) continue;

        const householdId = profileToHousehold.get(profile.id);
        if (!householdId) continue;
        const myChildren = (householdToRidingChildren.get(householdId) ?? []);
        if (myChildren.length === 0) continue;

        // Build a per-child sheet for each kid
        const childSheetsHtml: string[] = [];
        const childSheetsText: string[] = [];
        for (const child of myChildren) {
          const info = childTripInfo.get(child.id);
          if (!info) continue;
          const kidName = `${child.first_name} ${child.last_name}`.trim();

          const sheetLinesHtml: string[] = [];
          const sheetLinesText: string[] = [];
          for (const dir of ["morning", "afternoon"] as const) {
            const tripInfo = dir === "morning" ? info.morning : info.afternoon;
            const dirLabel = dir === "morning" ? "MORNING" : "AFTERNOON";
            if (!tripInfo) {
              sheetLinesHtml.push(`<p style="font-size:14px;margin:0 0 12px;padding:8px 12px;background:#fef2f2;border-radius:6px;color:#b91c1c;"><strong>${dirLabel}</strong> — ⚠️ No driver assigned — check with coordinator</p>`);
              sheetLinesText.push(`${dirLabel}: ⚠️ No driver assigned — check with coordinator`);
              continue;
            }
            const time = formatTime(tripInfo.meetingTime);
            const phoneStr = tripInfo.driverPhone
              ? formatPhone(tripInfo.driverPhone)
              : "phone not on file";
            const carmates = tripInfo.kidsWithPhones.filter((k: { name: string; phone: string | null }) => k.name !== child.first_name.trim());
            const carmatesStr = carmates.length > 0
              ? carmates.map((k: { name: string; phone: string | null }) => k.phone ? `${k.name} (${formatPhone(k.phone)})` : `${k.name} (no phone)`).join(", ")
              : "Riding alone";
            sheetLinesHtml.push(
              `<div style="margin:0 0 12px;padding:12px;background:#f8fafc;border-radius:8px;">` +
              `<p style="font-size:14px;margin:0 0 4px;font-weight:600;color:#118b8c;">${dirLabel} (${time} from ${escapeHtml(tripInfo.origin)})</p>` +
              `<p style="font-size:14px;margin:0 0 2px;">Driver: <strong>${escapeHtml(tripInfo.driverName)}</strong> — ${escapeHtml(phoneStr)}</p>` +
              `<p style="font-size:14px;margin:0 0 2px;color:#475569;">Car: ${escapeHtml(tripInfo.vehicleLabel) || "—"}</p>` +
              `<p style="font-size:14px;margin:0;color:#475569;">Riding with: ${escapeHtml(carmatesStr)}</p>` +
              `</div>`,
            );
            sheetLinesText.push(`${dirLabel} (${time} from ${tripInfo.origin})\n  Driver: ${tripInfo.driverName} — ${phoneStr}\n  Car: ${tripInfo.vehicleLabel || "—"}\n  Riding with: ${carmatesStr}`);
          }

          childSheetsHtml.push(
            `<div style="margin:0 0 20px;padding:16px;border:2px solid #e2e8f0;border-radius:12px;">` +
            `<p style="font-size:18px;font-weight:700;margin:0 0 12px;color:#0c2b52;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(kidName)} — ${escapeHtml(todayLabel)}</p>` +
            sheetLinesHtml.join("") +
            `</div>`,
          );
          childSheetsText.push(`═══════════════════════════════════\n${kidName} — ${todayLabel}\n═══════════════════════════════════\n${sheetLinesText.join("\n")}\n`);
        }

        if (childSheetsHtml.length === 0) continue;

        const firstName = (profile.full_name ?? "there").split(" ")[0];
        const kidFirstNames = myChildren.map((c: any) => c.first_name.trim());
        const kidsNameStr = kidFirstNames.length === 1
          ? `${kidFirstNames[0]}'s`
          : `${kidFirstNames.slice(0, -1).join(", ")} & ${kidFirstNames[kidFirstNames.length - 1]}'s`;
        const htmlBody =
          `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
          `<h1 style="font-size:20px;margin:0 0 8px;">${escapeHtml(kidsNameStr)} backpack sheet for ${escapeHtml(todayLabel)}</h1>` +
          `<p style="font-size:14px;margin:0 0 16px;color:#64748b;">Print this and put it in your kid's backpack. ${escapeHtml(firstName)}, here are your child(ren)'s rides today.</p>` +
          childSheetsHtml.join("") +
          `</body></html>`;

        const textBody =
          `${kidsNameStr} backpack sheet for ${todayLabel}\n\n` +
          `Print this and put it in your kid's backpack. ${firstName}, here are your child(ren)'s rides today.\n\n` +
          childSheetsText.join("\n");

        const idempotencySuffix = nonce ? `-${nonce}` : "";
        const idempotencyKey = `backpack-sheet-${today}-${profile.id}${idempotencySuffix}`;
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: profile.email,
              reply_to: RESEND_REPLY_TO,
              subject: `${kidsNameStr} backpack sheet for ${todayLabel}`,
              html: htmlBody,
              text: textBody,
              tags: [
                { name: "type", value: "backpack_sheet" },
                { name: "group", value: groupId ?? "unknown" },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error(`[send-push] Backpack sheet email to ${profile.email} failed:`, err);
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] Backpack sheet email to ${profile.email} threw:`, e);
          emailFailed++;
        }
      }

      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed, reason: "backpack_sheet" });
    }

    // ── drive_reminder: 75-min pre-drive email + push to confirmed drivers ─
    // Triggered by pg_cron at :00 and :25 every hour. Self-gates to the exact
    // Pacific minute that is 75 minutes before morning (8:40 AM) and afternoon
    // (5:15 PM) drive times. Each confirmed driver gets a personalized push +
    // email listing the kids in their car. Idempotency key is per-trip-per-driver.
    if (type === "drive_reminder") {
      const now = new Date();
      const parts = pacificParts(now, true);
      const pacificHour = parseInt(parts.hour, 10) % 24;
      const pacificMinute = parseInt(parts.minute, 10);

      // 90 min before 8:40 AM = 7:10 AM -> morning
      // 90 min before 5:15 PM = 3:45 PM -> afternoon
      let direction: "morning" | "afternoon" | null = null;
      if (pacificHour === 7 && pacificMinute >= 10 && pacificMinute < 15) {
        direction = "morning";
      } else if (pacificHour === 15 && pacificMinute >= 45 && pacificMinute < 50) {
        direction = "afternoon";
      }
      if (!direction) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "outside_window" });
      }

      // Today's Pacific date
      const today = `${parts.year}-${parts.month}-${parts.day}`;

      // Find today's trip in the given direction
      const trips = await supaFetch("trips", "id,service_date,direction,meeting_time,origin,destination,week_id,group_id", {
        service_date: `eq.${today}`,
        direction: `eq.${direction}`,
      });
      if (trips.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_trip_today" });
      }
      const trip = trips[0];
      const groupId = trip.group_id;

      // Find the published schedule version for this week
      const versions = await supaFetch("schedule_versions", "id", {
        week_id: `eq.${trip.week_id}`,
        group_id: `eq.${groupId}`,
        status: "eq.published",
      });
      if (versions.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_published_version" });
      }
      const versionId = versions[0].id;

      // Fetch confirmed driver assignments for this trip
      const driverAssignments = await supaFetch("driver_assignments", "id,driver_profile_id,vehicle_id", {
        schedule_version_id: `eq.${versionId}`,
        trip_id: `eq.${trip.id}`,
        group_id: `eq.${groupId}`,
        status: "eq.confirmed",
      });
      if (driverAssignments.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_confirmed_drivers" });
      }

      // Fetch rider assignments (kids in each car)
      const daIds = driverAssignments.map((da: any) => da.id);
      const riderAssignments = await supaFetch("rider_assignments", "child_id,driver_assignment_id", {
        driver_assignment_id: `in.(${daIds.join(",")})`,
      });
      const childIds = [...new Set(riderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0 ? await supaFetch("children", "id,first_name,last_name", { id: `in.(${childIds.join(",")})` }) : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      // Build driver_assignment_id -> kid names
      const kidsByDriver = new Map<string, string[]>();
      for (const ra of riderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = `${child.first_name} ${child.last_name}`.trim();
        const arr = kidsByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push(kidName);
        kidsByDriver.set(ra.driver_assignment_id, arr);
      }

      // Fetch driver profiles
      const driverProfileIds = driverAssignments.map((da: any) => da.driver_profile_id);
      const driverProfiles = await supaFetch("profiles", "id,full_name,email", { id: `in.(${driverProfileIds.join(",")})` });
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const formattedTime = formatTime(trip.meeting_time);
      const period = direction === "morning" ? "morning" : "afternoon";

      ensureVapid();

      let sent = 0;
      let failed = 0;
      let removed = 0;
      let emailSent = 0;
      let emailFailed = 0;

      for (const da of driverAssignments) {
        const driver = driverProfileMap.get(da.driver_profile_id);
        if (!driver) continue;
        const kids = kidsByDriver.get(da.id) ?? [];
        const kidsStr = kids.length > 0 ? ` Kids in your car: ${kids.join(", ")}.` : "";
        const bodyText = `Your ${period} drive starts at ${formattedTime} from ${trip.origin}.${kidsStr}`;
        const title = "Drive in 90 minutes";
        const tag = `drive-reminder-${trip.id}-${da.driver_profile_id}`;
        const pushPayload = JSON.stringify({ title, body: bodyText, tag, url: "/" });

        // Push to this driver's subscriptions
        const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${da.driver_profile_id}` });
        for (const sub of subs) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
              pushPayload,
              { TTL: 2419200 },
            );
            sent++;
          } catch (error: any) {
            failed++;
            const statusCode = error?.statusCode ?? 0;
            if (statusCode === 410 || statusCode === 404) {
              console.log(`[send-push] Removing dead subscription (status ${statusCode}): ${sub.endpoint.slice(0, 60)}...`);
              await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
              removed++;
            } else {
              console.error(`[send-push] Drive reminder push failed (status ${statusCode}):`, error?.message ?? error);
            }
          }
        }

        // Email to this driver
        if (driver.email && RESEND_API_KEY) {
          if (isTestEmail(driver.email)) continue;
          const cta = APP_URL
            ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
            : "";
          const htmlBody =
            `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
            `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>` +
            `<p style="font-size:15px;color:#0c2b52;line-height:1.5;">${escapeHtml(bodyText)}</p>` +
            `<p style="margin-top:24px;">${cta}</p>` +
            `</body></html>`;
          try {
            const res = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `carpool-${tag}`,
              },
              body: JSON.stringify({
                from: RESEND_FROM_EMAIL,
                to: driver.email,
                reply_to: RESEND_REPLY_TO,
                subject: title,
                html: htmlBody,
                text: bodyText,
                tags: [
                  { name: "type", value: "drive_reminder" },
                  { name: "group", value: groupId ?? "unknown" },
                ],
              }),
            });
            if (!res.ok) {
              const err = await res.text();
              console.error(`[send-push] Drive reminder email to ${driver.email} failed:`, err);
              emailFailed++;
            } else {
              emailSent++;
            }
          } catch (e) {
            console.error(`[send-push] Drive reminder email to ${driver.email} threw:`, e);
            emailFailed++;
          }
        }
      }

      return jsonResponse({ sent, failed, removed, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── status_reminder: 30-min pre-drive action prompt ──────────────
    // Notifies drivers to tap "I'm on my way" and (morning only) rider
    // parents to tap "Mark ready". Afternoon rider parents get nothing —
    // kids are at school together, no "at the curb" status needed.
    if (type === "status_reminder") {
      const now = new Date();
      const parts = pacificParts(now, true);
      const pacificHour = parseInt(parts.hour, 10) % 24;
      const pacificMinute = parseInt(parts.minute, 10);

      // 30 min before 8:40 AM = 8:10 AM -> morning
      // 30 min before 5:15 PM = 4:45 PM -> afternoon
      let direction: "morning" | "afternoon" | null = null;
      if (pacificHour === 8 && pacificMinute >= 10 && pacificMinute < 15) {
        direction = "morning";
      } else if (pacificHour === 16 && pacificMinute >= 45 && pacificMinute < 50) {
        direction = "afternoon";
      }
      if (!direction) {
        return jsonResponse({ sent: 0, failed: 0, reason: "outside_window" });
      }

      const today = `${parts.year}-${parts.month}-${parts.day}`;
      const trips = await supaFetch("trips", "id,service_date,direction,meeting_time,origin,destination,week_id,group_id", {
        service_date: `eq.${today}`,
        direction: `eq.${direction}`,
      });
      if (trips.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, reason: "no_trip_today" });
      }
      const trip = trips[0];
      const groupId = trip.group_id;

      const versions = await supaFetch("schedule_versions", "id", {
        week_id: `eq.${trip.week_id}`,
        group_id: `eq.${groupId}`,
        status: "eq.published",
      });
      if (versions.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, reason: "no_published_version" });
      }
      const versionId = versions[0].id;

      const driverAssignments = await supaFetch("driver_assignments", "id,driver_profile_id,vehicle_id", {
        schedule_version_id: `eq.${versionId}`,
        trip_id: `eq.${trip.id}`,
        group_id: `eq.${groupId}`,
        status: "eq.confirmed",
      });
      if (driverAssignments.length === 0) {
        return jsonResponse({ sent: 0, failed: 0, reason: "no_confirmed_drivers" });
      }

      // Fetch rider assignments + children
      const daIds = driverAssignments.map((da: any) => da.id);
      const riderAssignments = await supaFetch("rider_assignments", "child_id,driver_assignment_id", {
        driver_assignment_id: `in.(${daIds.join(",")})`,
      });
      const childIds = [...new Set(riderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0 ? await supaFetch("children", "id,first_name,last_name,household_id", { id: `in.(${childIds.join(",")})` }) : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      // Build driver_assignment_id -> kid names
      const kidsByDriver = new Map<string, string[]>();
      for (const ra of riderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = `${child.first_name} ${child.last_name}`.trim();
        const arr = kidsByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push(kidName);
        kidsByDriver.set(ra.driver_assignment_id, arr);
      }

      // Fetch driver profiles
      const driverProfileIds = driverAssignments.map((da: any) => da.driver_profile_id);
      const driverProfiles = await supaFetch("profiles", "id,full_name", { id: `in.(${driverProfileIds.join(",")})` });
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const formattedTime = formatTime(trip.meeting_time);
      const period = direction === "morning" ? "morning" : "afternoon";
      const isMorning = direction === "morning";

      ensureVapid();

      let sent = 0;
      let failed = 0;
      let removed = 0;

      // ── Driver notifications: "Tap I'm on my way" ──
      for (const da of driverAssignments) {
        const driver = driverProfileMap.get(da.driver_profile_id);
        if (!driver) continue;
        const kids = kidsByDriver.get(da.id) ?? [];
        const kidsStr = kids.length > 0 ? ` Kids: ${kids.join(", ")}.` : "";
        const bodyText = `Tap "I'm on my way" for the ${formattedTime} ${period} pickup.${kidsStr}`;
        const title = "On your way soon?";
        const tag = `status-reminder-driver-${trip.id}-${da.driver_profile_id}`;
        const pushPayload = JSON.stringify({ title, body: bodyText, tag, url: "/" });

        const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${da.driver_profile_id}` });
        for (const sub of subs) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
              pushPayload,
              { TTL: 2419200 },
            );
            sent++;
          } catch (error: any) {
            failed++;
            const statusCode = error?.statusCode ?? 0;
            if (statusCode === 410 || statusCode === 404) {
              await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
              removed++;
            }
          }
        }
      }

      // ── Rider parent notifications (morning only): "Tap Mark ready" ──
      if (isMorning && childIds.length > 0) {
        // Build child_id -> driver_name mapping
        const childToDriver = new Map<string, string>();
        for (const ra of riderAssignments) {
          const da = driverAssignments.find((d: any) => d.id === ra.driver_assignment_id);
          if (da) {
            const driver = driverProfileMap.get(da.driver_profile_id);
            if (driver) childToDriver.set(ra.child_id, driver.full_name.split(" ")[0]);
          }
        }

        // Collect distinct households from children
        const householdIds = [...new Set(children.map((c: any) => c.household_id))];
        for (const hid of householdIds) {
          const members = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
          // Find children in this household
          const householdChildren = children.filter((c: any) => c.household_id === hid);
          const childNames = householdChildren.map((c: any) => c.first_name).join(" and ");
          const driverNames = householdChildren.map((c: any) => childToDriver.get(c.id)).filter(Boolean);
          const driverStr = driverNames.length > 0 ? ` ${driverNames[0]} is driving.` : "";

          for (const member of members) {
            const bodyText = `On your way? Tap "I'm on my way" in the app for the ${formattedTime} pickup.${driverStr}`;
            const title = `On your way?`;
            const tag = `status-reminder-rider-${trip.id}-${member.profile_id}`;
            const pushPayload = JSON.stringify({ title, body: bodyText, tag, url: "/" });

            const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${member.profile_id}` });
            for (const sub of subs) {
              try {
                await webpush.sendNotification(
                  { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
                  pushPayload,
                  { TTL: 2419200 },
                );
                sent++;
              } catch (error: any) {
                failed++;
                const statusCode = error?.statusCode ?? 0;
                if (statusCode === 410 || statusCode === 404) {
                  await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
                  removed++;
                }
              }
            }
          }
        }
      }

      return jsonResponse({ sent, failed, removed });
    }

    // ── drive_confirmed: email calendar invite to the confirmed driver ──
    // Triggered by the client immediately after respondToDriverAssignment
    // returns "confirmed". Sends an email with a .ics attachment covering the
    // full drive duration: 15 min before meeting (drive to pickup) through
    // 45 min after departure (drive to school + drive home). Also includes
    // Google Calendar and Outlook links as fallbacks. Idempotency key is
    // per-assignment so a re-confirm dedupes.
    if (type === "drive_confirmed" && assignment_id) {
      const assignment = await supaFetch("driver_assignments", "id,driver_profile_id,vehicle_id,trip_id,group_id,updated_at,status", { id: `eq.${assignment_id}` });
      if (assignment.length === 0) return jsonError("Assignment not found", 404);
      const da = assignment[0];

      // Guard: only send calendar invite for active assignments (confirmed or tentative).
      // A 'released' or 'declined' assignment means the driver is no longer driving —
      // don't send them a calendar invite for a drive they're not doing.
      if (da.status !== "confirmed" && da.status !== "tentative") {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true, reason: `assignment_${da.status}` });
      }

      const tripData = await supaFetch("trips", "id,service_date,direction,meeting_time,departure_time,origin,destination,week_id,group_id", { id: `eq.${da.trip_id}` });
      if (tripData.length === 0) return jsonError("Trip not found", 404);
      const trip = tripData[0];

      const driverProfile = await supaFetch("profiles", "id,full_name,email", { id: `eq.${da.driver_profile_id}` });
      if (driverProfile.length === 0) return jsonError("Driver not found", 404);
      const driver = driverProfile[0];
      if (!driver.email || isTestEmail(driver.email)) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true });
      }
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      // Fetch rider assignments (kids in this car)
      const riderAssignments = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: `eq.${assignment_id}` });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      const children = childIds.length > 0 ? await supaFetch("children", "first_name,last_name", { id: `in.(${childIds.join(",")})` }) : [];
      const kidNames = children.map((c: any) => `${c.first_name} ${c.last_name}`.trim());

      // Fetch vehicle label
      let vehicleLabel = "";
      if (da.vehicle_id) {
        const vehicles = await supaFetch("vehicles", "label", { id: `eq.${da.vehicle_id}` });
        if (vehicles.length > 0) vehicleLabel = vehicles[0].label;
      }

      const groupId = da.group_id;
      const timezone = "America/Los_Angeles";
      const firstName = (driver.full_name ?? "there").split(" ")[0];
      const dirLabel = trip.direction === "morning" ? "morning" : "afternoon";
      const meetingTime = formatTime(trip.meeting_time);
      const departureTime = formatTime(trip.departure_time);

      // Calendar event: 15 min before meeting through 45 min after departure
      const eventStart = addMinutes(trip.meeting_time, -15);
      const eventEnd = addMinutes(trip.departure_time, 45);
      const dtstart = toIcsLocal(trip.service_date, eventStart);
      const dtend = toIcsLocal(trip.service_date, eventEnd);
      const dtstamp = toIcsLocal(
        new Date().toISOString().slice(0, 10),
        new Date().toTimeString().slice(0, 5),
      );
      const summary = `Carpool Crew: ${dirLabel === "morning" ? "Morning" : "Afternoon"} drive to ${trip.destination}`;
      const ridersStr = kidNames.length > 0 ? kidNames.join(", ") : "No riders assigned";
      const description = `Riders: ${ridersStr}\\nVehicle: ${vehicleLabel || "Unknown"}\\nMeet at ${meetingTime} at ${trip.origin}\\nDepart ${departureTime}`;
      const icsContent = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Carpool Crew//EN",
        `X-WR-TIMEZONE:${timezone}`,
        "BEGIN:VEVENT",
        `UID:drive-confirmed-${assignment_id}@carpoolcrew.co`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${timezone}:${dtstart}`,
        `DTEND;TZID=${timezone}:${dtend}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${description}`,
        `LOCATION:${trip.origin}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      // Base64-encode the ICS for the Resend attachment
      const icsBase64 = btoa(unescape(encodeURIComponent(icsContent)));

      // Google Calendar link (fallback)
      const googleStart = toIcsLocal(trip.service_date, eventStart);
      const googleEnd = toIcsLocal(trip.service_date, eventEnd);
      const googleParams = new URLSearchParams({
        action: "TEMPLATE",
        text: summary,
        dates: `${googleStart}/${googleEnd}`,
        ctz: timezone,
        location: trip.origin,
        details: description.replaceAll("\\n", "\n"),
      });
      const googleUrl = `https://calendar.google.com/calendar/render?${googleParams.toString()}`;

      const kidsStr = kidNames.length > 0 ? ` Kids in your car: ${kidNames.join(", ")}.` : "";
      const htmlBody =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
        `<h1 style="font-size:22px;margin:0 0 16px;">You're driving, ${escapeHtml(firstName)}</h1>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Your ${dirLabel} drive is confirmed for ${escapeHtml(trip.service_date)}. Meet at ${escapeHtml(trip.origin)} at ${escapeHtml(meetingTime)}. Depart ${escapeHtml(departureTime)}.${kidsStr}</p>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">A calendar invite is attached to this email. Open it to add the event to your calendar — it covers the full drive (15 min before pickup through 45 min after departure).</p>` +
        `<p style="font-size:14px;line-height:1.6;margin:0 0 16px;">Or add via <a href="${googleUrl}">Google Calendar</a>.</p>` +
        `<p style="margin-top:24px;">${APP_URL ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>` : ""}</p>` +
        `</body></html>`;

      const textBody =
        `You're driving, ${firstName}\n\n` +
        `Your ${dirLabel} drive is confirmed for ${trip.service_date}. Meet at ${trip.origin} at ${meetingTime}. Depart ${departureTime}.${kidsStr}\n\n` +
        `A calendar invite is attached to this email. Open it to add the event to your calendar — it covers the full drive (15 min before pickup through 45 min after departure).\n\n` +
        `Or add via Google Calendar: ${googleUrl}`;

      const idempotencyKey = `drive-confirmed-${assignment_id}-${da.updated_at}`;
      let emailSent = 0;
      let emailFailed = 0;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: driver.email,
            reply_to: RESEND_REPLY_TO,
            subject: `You're driving ${dirLabel} — ${trip.service_date}`,
            html: htmlBody,
            text: textBody,
            attachments: [
              {
                filename: "carpool-crew-drive.ics",
                content: icsBase64,
              },
            ],
            tags: [
              { name: "type", value: "drive_confirmed" },
              { name: "group", value: groupId ?? "unknown" },
            ],
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          console.error(`[send-push] Drive confirmed email to ${driver.email} failed:`, err);
          emailFailed++;
        } else {
          emailSent++;
        }
      } catch (e) {
        console.error(`[send-push] Drive confirmed email to ${driver.email} threw:`, e);
        emailFailed++;
      }
      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── drive_cancelled: calendar cancellation email to the driver ──
    // Triggered by the client when a driver declines a previously confirmed
    // drive. Sends a .ics with METHOD:CANCEL so the driver's calendar app
    // removes the event. Also sends a plain-text "drive cancelled" email.
    // Idempotency key includes updated_at so a re-decline after re-accept
    // gets a fresh key.
    if (type === "drive_cancelled" && assignment_id) {
      const assignment = await supaFetch("driver_assignments", "id,driver_profile_id,vehicle_id,trip_id,group_id,updated_at,status", { id: `eq.${assignment_id}` });
      if (assignment.length === 0) return jsonError("Assignment not found", 404);
      const da = assignment[0];

      // Guard: only send calendar cancellation for assignments the driver actually
      // declined or let expire. A 'released' assignment means someone else took over —
      // don't send a cancellation to the original driver (the volunteer gets the cancel
      // email if they decline their own assignment).
      if (da.status !== "declined" && da.status !== "expired") {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true, reason: `assignment_${da.status}` });
      }

      const tripData = await supaFetch("trips", "id,service_date,direction,meeting_time,departure_time,origin,destination,week_id,group_id", { id: `eq.${da.trip_id}` });
      if (tripData.length === 0) return jsonError("Trip not found", 404);
      const trip = tripData[0];

      const driverProfile = await supaFetch("profiles", "id,full_name,email", { id: `eq.${da.driver_profile_id}` });
      if (driverProfile.length === 0) return jsonError("Driver not found", 404);
      const driver = driverProfile[0];
      if (!driver.email || isTestEmail(driver.email)) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true });
      }
      if (!RESEND_API_KEY) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "no_resend_key" });
      }

      const groupId = da.group_id;
      const timezone = "America/Los_Angeles";
      const firstName = (driver.full_name ?? "there").split(" ")[0];
      const dirLabel = trip.direction === "morning" ? "morning" : "afternoon";

      // ICS with METHOD:CANCEL so calendar apps remove the event
      const dtstamp = toIcsLocal(
        new Date().toISOString().slice(0, 10),
        new Date().toTimeString().slice(0, 5),
      );
      const icsContent = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Carpool Crew//EN",
        `X-WR-TIMEZONE:${timezone}`,
        "METHOD:CANCEL",
        "BEGIN:VEVENT",
        `UID:drive-confirmed-${assignment_id}@carpoolcrew.co`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${timezone}:${toIcsLocal(trip.service_date, addMinutes(trip.meeting_time, -15))}`,
        `DTEND;TZID=${timezone}:${toIcsLocal(trip.service_date, addMinutes(trip.departure_time, 45))}`,
        `SUMMARY:CANCELLED: Carpool Crew: ${dirLabel === "morning" ? "Morning" : "Afternoon"} drive`,
        "STATUS:CANCELLED",
        `LOCATION:${trip.origin}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const icsBase64 = btoa(unescape(encodeURIComponent(icsContent)));

      const htmlBody =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">` +
        `<h1 style="font-size:22px;margin:0 0 16px;">Drive cancelled, ${escapeHtml(firstName)}</h1>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Your ${dirLabel} drive on ${escapeHtml(trip.service_date)} has been cancelled. A calendar cancellation is attached so your calendar app can remove the event.</p>` +
        `<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Affected families have been notified that their child needs a new ride.</p>` +
        `<p style="margin-top:24px;">${APP_URL ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>` : ""}</p>` +
        `</body></html>`;

      const textBody =
        `Drive cancelled, ${firstName}\n\n` +
        `Your ${dirLabel} drive on ${trip.service_date} has been cancelled. A calendar cancellation is attached so your calendar app can remove the event.\n\n` +
        `Affected families have been notified that their child needs a new ride.`;

      const idempotencyKey = `drive-cancelled-${assignment_id}-${da.updated_at}`;
      let emailSent = 0;
      let emailFailed = 0;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: driver.email,
            reply_to: RESEND_REPLY_TO,
            subject: `Drive cancelled — ${trip.service_date}`,
            html: htmlBody,
            text: textBody,
            attachments: [
              {
                filename: "carpool-crew-cancel.ics",
                content: icsBase64,
              },
            ],
            tags: [
              { name: "type", value: "drive_cancelled" },
              { name: "group", value: groupId ?? "unknown" },
            ],
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          console.error(`[send-push] Drive cancelled email to ${driver.email} failed:`, err);
          emailFailed++;
        } else {
          emailSent++;
        }
      } catch (e) {
        console.error(`[send-push] Drive cancelled email to ${driver.email} threw:`, e);
        emailFailed++;
      }
      return jsonResponse({ sent: 0, failed: 0, email_sent: emailSent, email_failed: emailFailed });
    }

    // ── rider_cancelled: "child won't be riding" email + push to driver ──
    // Triggered when a parent cancels their child's ride via the Today card.
    // The client calls sendPushNotification(assignment_id, null, "rider_cancelled", child_id).
    if (type === "rider_cancelled" && assignment_id) {
      const childId: string | undefined = body.child_id;
      if (!childId) return jsonError("Missing child_id for rider_cancelled", 400);

      // Load the driver assignment → trip + driver profile
      const daRows = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,group_id,schedule_version_id", { id: `eq.${assignment_id}` });
      if (daRows.length === 0) return jsonError("Driver assignment not found", 404);
      const da = daRows[0];

      // Load the trip
      const tripRows = await supaFetch("trips", "service_date,direction,meeting_time,origin,destination", { id: `eq.${da.trip_id}` });
      if (tripRows.length === 0) return jsonError("Trip not found", 404);
      const trip = tripRows[0];

      // Load the child
      const childRows = await supaFetch("children", "first_name,last_name", { id: `eq.${childId}` });
      if (childRows.length === 0) return jsonError("Child not found", 404);
      const child = childRows[0];
      const childName = `${child.first_name} ${child.last_name}`;

      // Load the driver's profile for email
      const driverRows = await supaFetch("profiles", "id,full_name,email", { id: `eq.${da.driver_profile_id}` });
      if (driverRows.length === 0) return jsonError("Driver profile not found", 404);
      const driver = driverRows[0];
      if (isTestEmail(driver.email)) {
        return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, skipped: true });
      }

      const dirLabel = trip.direction === "morning" ? "Morning" : "Afternoon";
      const tripDate = new Date(trip.service_date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      const cta = APP_URL
        ? `<p style="margin:24px 0 0;"><a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:#118b8c;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Open the app</a></p>`
        : "";

      const htmlBody = `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">
<h1 style="font-size:22px;margin:0 0 16px;">Ride update</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>${escapeHtml(childName)}</strong> won't be riding ${escapeHtml(dirLabel.toLowerCase())} on ${escapeHtml(tripDate)}.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Their parent cancelled this ride. You're still scheduled to drive — other children may still need a ride.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Trip: ${escapeHtml(trip.meeting_time)} · ${escapeHtml(trip.origin)} → ${escapeHtml(trip.destination)}</p>
${cta}
</body></html>`;

      const textBody = `Ride update

${childName} won't be riding ${dirLabel.toLowerCase()} on ${tripDate}.

Their parent cancelled this ride. You're still scheduled to drive — other children may still need a ride.

Trip: ${trip.meeting_time} · ${trip.origin} → ${trip.destination}`;

      let emailSent = 0;
      let emailFailed = 0;
      if (RESEND_API_KEY) {
        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": `rider-cancelled-${assignment_id}-${childId}`,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: driver.email,
              reply_to: RESEND_REPLY_TO || undefined,
              subject: `${childName} won't be riding ${dirLabel} — ${tripDate}`,
              html: htmlBody,
              text: textBody,
              tags: [
                { name: "type", value: "rider_cancelled" },
                { name: "group", value: da.group_id },
              ],
            }),
          });
          if (!resp.ok) {
            console.error("[send-push] rider_cancelled email failed:", await resp.text());
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] rider_cancelled email to ${driver.email} threw:`, e);
          emailFailed++;
        }
      }

      // Send push notification to the driver
      let sent = 0;
      let failed = 0;
      const pushTitle = `${childName} won't be riding ${dirLabel.toLowerCase()}`;
      const pushBody = `Their parent cancelled this ride for ${tripDate}.`;
      try {
        await sendEmailAndPush(da.driver_profile_id, pushTitle, pushBody, `rider-cancelled-${assignment_id}-${childId}`, `rider-cancelled-${assignment_id}-${childId}`, da.group_id);
        sent++;
      } catch (e) {
        console.error("[send-push] rider_cancelled push failed:", e);
        failed++;
      }

      return jsonResponse({ sent, failed, email_sent: emailSent, email_failed: emailFailed });
    }

    if (type === "rider_cancelled_by_coordinator" && assignment_id) {
      const childId: string | undefined = body.child_id;
      if (!childId) return jsonError("Missing child_id for rider_cancelled_by_coordinator", 400);

      // Load the driver assignment → trip + driver profile
      const daRows = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,group_id,schedule_version_id", { id: `eq.${assignment_id}` });
      if (daRows.length === 0) return jsonError("Driver assignment not found", 404);
      const da = daRows[0];

      // Load the trip
      const tripRows = await supaFetch("trips", "service_date,direction,meeting_time,origin,destination", { id: `eq.${da.trip_id}` });
      if (tripRows.length === 0) return jsonError("Trip not found", 404);
      const trip = tripRows[0];

      // Load the child + household
      const childRows = await supaFetch("children", "first_name,last_name,household_id", { id: `eq.${childId}` });
      if (childRows.length === 0) return jsonError("Child not found", 404);
      const child = childRows[0];
      const childName = `${child.first_name} ${child.last_name}`;

      const dirLabel = trip.direction === "morning" ? "Morning" : "Afternoon";
      const tripDate = new Date(trip.service_date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      const cta = APP_URL
        ? `<p style="margin:24px 0 0;"><a href="${APP_URL}" style="display:inline-block;padding:10px 24px;background:#118b8c;color:#fff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">Open the app</a></p>`
        : "";

      let emailSent = 0;
      let emailFailed = 0;
      let sent = 0;
      let failed = 0;

      // ── 1. Notify the driver ──
      const driverRows = await supaFetch("profiles", "id,full_name,email", { id: `eq.${da.driver_profile_id}` });
      if (driverRows.length > 0) {
        const driver = driverRows[0];
        if (!isTestEmail(driver.email)) {
          const driverHtml = `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">
<h1 style="font-size:22px;margin:0 0 16px;">Ride update</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;"><strong>${escapeHtml(childName)}</strong> was removed from your ${escapeHtml(dirLabel.toLowerCase())} drive on ${escapeHtml(tripDate)} by a coordinator.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">You're still scheduled to drive — other children may still need a ride.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 8px;">Trip: ${escapeHtml(trip.meeting_time)} · ${escapeHtml(trip.origin)} → ${escapeHtml(trip.destination)}</p>
${cta}
</body></html>`;
          const driverText = `Ride update\n\n${childName} was removed from your ${dirLabel.toLowerCase()} drive on ${tripDate} by a coordinator.\n\nYou're still scheduled to drive — other children may still need a ride.\n\nTrip: ${trip.meeting_time} · ${trip.origin} → ${trip.destination}`;

          if (RESEND_API_KEY) {
            try {
              const resp = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${RESEND_API_KEY}`,
                  "Content-Type": "application/json",
                  "Idempotency-Key": `rider-cancelled-coord-driver-${assignment_id}-${childId}`,
                },
                body: JSON.stringify({
                  from: RESEND_FROM_EMAIL,
                  to: driver.email,
                  reply_to: RESEND_REPLY_TO || undefined,
                  subject: `${childName} removed from your ${dirLabel} drive — ${tripDate}`,
                  html: driverHtml,
                  text: driverText,
                  tags: [
                    { name: "type", value: "rider_cancelled_by_coordinator" },
                    { name: "recipient", value: "driver" },
                    { name: "group", value: da.group_id },
                  ],
                }),
              });
              if (!resp.ok) {
                console.error("[send-push] rider_cancelled_by_coordinator driver email failed:", await resp.text());
                emailFailed++;
              } else {
                emailSent++;
              }
            } catch (e) {
              console.error(`[send-push] rider_cancelled_by_coordinator driver email to ${driver.email} threw:`, e);
              emailFailed++;
            }
          }

          try {
            await sendEmailAndPush(da.driver_profile_id, `${childName} removed from your ${dirLabel.toLowerCase()} drive`, `A coordinator removed ${childName} from your ${tripDate} drive.`, `rider-cancelled-coord-driver-push-${assignment_id}-${childId}`, `rider-cancelled-coord-${assignment_id}-${childId}`, da.group_id);
            sent++;
          } catch (e) {
            console.error("[send-push] rider_cancelled_by_coordinator driver push failed:", e);
            failed++;
          }
        }
      }

      // ── 2. Notify the child's household members ──
      const familyMemberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${child.household_id}`, status: `eq.active` });
      const familyProfileIds = familyMemberships.map((m: any) => m.profile_id);
      const familyProfiles = familyProfileIds.length > 0
        ? await supaFetch("profiles", "id,full_name,email", { id: `in.(${familyProfileIds.join(",")})` })
        : [];

      for (const famProfile of familyProfiles) {
        if (!famProfile.email || isTestEmail(famProfile.email)) continue;
        const familyHtml = `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0c2b52;">
<h1 style="font-size:22px;margin:0 0 16px;">Schedule update</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">A coordinator removed <strong>${escapeHtml(childName)}</strong> from the ${escapeHtml(dirLabel.toLowerCase())} carpool drive on ${escapeHtml(tripDate)}.</p>
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">If you believe this was a mistake, please contact the coordinator.</p>
${cta}
</body></html>`;
        const familyText = `Schedule update\n\nA coordinator removed ${childName} from the ${dirLabel.toLowerCase()} carpool drive on ${tripDate}.\n\nIf you believe this was a mistake, please contact the coordinator.`;

        if (RESEND_API_KEY) {
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
                "Idempotency-Key": `rider-cancelled-coord-family-${assignment_id}-${childId}-${famProfile.id}`,
              },
              body: JSON.stringify({
                from: RESEND_FROM_EMAIL,
                to: famProfile.email,
                reply_to: RESEND_REPLY_TO || undefined,
                subject: `${childName} removed from ${dirLabel} drive — ${tripDate}`,
                html: familyHtml,
                text: familyText,
                tags: [
                  { name: "type", value: "rider_cancelled_by_coordinator" },
                  { name: "recipient", value: "family" },
                  { name: "group", value: da.group_id },
                ],
              }),
            });
            if (!resp.ok) {
              console.error("[send-push] rider_cancelled_by_coordinator family email failed:", await resp.text());
              emailFailed++;
            } else {
              emailSent++;
            }
          } catch (e) {
            console.error(`[send-push] rider_cancelled_by_coordinator family email to ${famProfile.email} threw:`, e);
            emailFailed++;
          }
        }
      }

      return jsonResponse({ sent, failed, email_sent: emailSent, email_failed: emailFailed });
    }

    let recipientProfileIds: string[] = [];
    let title = "";
    let bodyText = "";
    let tag = "carpool";
    let groupId: string | null = null;
    let emailBodyHtml: string | null = null;

    if (type === "declined" && assignment_id) {
      const riderAssignments = await supaFetch("rider_assignments", "*", { driver_assignment_id: `eq.${assignment_id}` });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      if (childIds.length === 0) return jsonError("No riders found", 404);

      const children = await supaFetch("children", "household_id,id", { id: `in.(${childIds.join(",")})` });
      const householdIds = [...new Set(children.map((c: any) => c.household_id))];

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }

      const assignment = await supaFetch("driver_assignments", "*", { id: `eq.${assignment_id}` });
      if (assignment.length > 0) {
        const da = assignment[0];
        // Exclude the declining driver from receiving their own cancellation push.
        recipientProfileIds = recipientProfileIds.filter((id: string) => id !== da.driver_profile_id);
        const driver = await supaFetch("profiles", "full_name", { id: `eq.${da.driver_profile_id}` });
        const trip = await supaFetch("trips", "*", { id: `eq.${da.trip_id}` });
        if (trip.length > 0) {
          const t = trip[0];
          const period = t.direction === "morning" ? "morning" : "afternoon";
          const driverName = driver.length > 0 ? driver[0].full_name : "A driver";
          title = "Drive cancelled";
          bodyText = `${driverName} declined the ${period} trip on ${t.service_date}. Your child needs a new ride.`;
          tag = `declined-${assignment_id}`;
        }
      }
    } else if (type === "uncovered" && version_id) {
      const driverAssignments = await supaFetch("driver_assignments", "*", { schedule_version_id: `eq.${version_id}`, status: "in.(tentative,confirmed)" });
      const coveredRiderIds = new Set<string>();

      for (const da of driverAssignments) {
        const riders = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: `eq.${da.id}` });
        riders.forEach((r: any) => coveredRiderIds.add(r.child_id));
      }

      const versionData = await supaFetch("schedule_versions", "week_id,group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id, week_id } = versionData[0];
      groupId = group_id;

      // Scope ride_requests to this version's week only — not the whole group.
      // Without scoping, families get false "your child doesn't have a ride"
      // pushes for weeks they haven't checked in for yet.
      const trips = await supaFetch("trips", "id", { group_id: `eq.${group_id}`, week_id: `eq.${week_id}` });
      const tripIds = trips.map((t: any) => t.id);
      if (tripIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const rideRequests = await supaFetch("ride_requests", "*", {
        trip_id: `in.(${tripIds.join(",")})`,
        needs_ride: "eq.true",
      });
      const uncoveredChildren = rideRequests
        .filter((rr: any) => !coveredRiderIds.has(rr.child_id))
        .map((rr: any) => rr.child_id);

      if (uncoveredChildren.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const children = await supaFetch("children", "id,household_id", { id: `in.(${uncoveredChildren.join(",")})` });
      const childMap = new Map(children.map((c: any) => [c.id, c.household_id]));
      const householdIds = new Set<string>();
      for (const cid of uncoveredChildren) {
        const hid = childMap.get(cid);
        if (hid) householdIds.add(hid);
      }

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }

      title = "Ride needed";
      bodyText = `Your child doesn't have a ride assigned for this week. Check the schedule or contact the admin.`;
      tag = `uncovered-${version_id}`;
    } else if (type === "published" && version_id) {
      const versionData = await supaFetch("schedule_versions", "group_id,week_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id, week_id } = versionData[0];
      groupId = group_id;

      const memberships = await supaFetch("memberships", "profile_id", { group_id: `eq.${group_id}`, status: "eq.active" });
      recipientProfileIds = memberships.map((m: any) => m.profile_id);

      // ── Build the full week's roster for the email body ──
      // Mirrors the coordinator_tentative_summary roster pattern but for a
      // published schedule (all assignments confirmed). Matches the This Week
      // tab: only parents/kids who completed check-in appear in the roster.
      const weekData = await supaFetch("weeks", "starts_on", { id: `eq.${week_id}` });
      const weekStartDate = weekData.length > 0 ? weekData[0].starts_on : "";

      const trips = await supaFetch("trips", "id,service_date,direction,meeting_time,origin,destination", {
        week_id: `eq.${week_id}`,
        group_id: `eq.${group_id}`,
      });
      const tripIds = trips.map((t: any) => t.id);

      const driverAssignments = tripIds.length > 0
        ? await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,vehicle_id,status,child_passenger_capacity", {
            schedule_version_id: `eq.${version_id}`,
            trip_id: `in.(${tripIds.join(",")})`,
            status: "eq.confirmed",
          })
        : [];
      const daIds = driverAssignments.map((da: any) => da.id);
      const riderAssignments = daIds.length > 0
        ? await supaFetch("rider_assignments", "child_id,driver_assignment_id", { driver_assignment_id: `in.(${daIds.join(",")})` })
        : [];

      const childIds = [...new Set(riderAssignments.map((ra: any) => ra.child_id))];
      const children = childIds.length > 0
        ? await supaFetch("children", "id,first_name,last_name", { id: `in.(${childIds.join(",")})` })
        : [];
      const childMap = new Map(children.map((c: any) => [c.id, c]));

      const driverProfileIds = [...new Set(driverAssignments.map((da: any) => da.driver_profile_id))];
      const driverProfiles = driverProfileIds.length > 0
        ? await supaFetch("profiles", "id,full_name", { id: `in.(${driverProfileIds.join(",")})` })
        : [];
      const driverProfileMap = new Map(driverProfiles.map((p: any) => [p.id, p]));

      const vehicleIds = [...new Set(driverAssignments.map((da: any) => da.vehicle_id).filter(Boolean))];
      const vehicles = vehicleIds.length > 0
        ? await supaFetch("vehicles", "id,label", { id: `in.(${vehicleIds.join(",")})` })
        : [];
      const vehicleMap = new Map(vehicles.map((v: any) => [v.id, v]));

      const tripRidersByDriver = new Map<string, string[]>();
      for (const ra of riderAssignments) {
        const child = childMap.get(ra.child_id);
        if (!child) continue;
        const kidName = `${child.first_name} ${child.last_name}`.trim();
        const arr = tripRidersByDriver.get(ra.driver_assignment_id) ?? [];
        arr.push(kidName);
        tripRidersByDriver.set(ra.driver_assignment_id, arr);
      }

      const tripsByDate = new Map<string, any[]>();
      for (const trip of trips) {
        const arr = tripsByDate.get(trip.service_date) ?? [];
        arr.push(trip);
        tripsByDate.set(trip.service_date, arr);
      }
      const sortedDates = [...tripsByDate.keys()].sort();

      const rosterHtmlLines: string[] = [];
      for (const date of sortedDates) {
        const dayTrips = tripsByDate.get(date) ?? [];
        const dayLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
        rosterHtmlLines.push(`<h2 style="font-size:16px;margin:20px 0 8px;color:#0c2b52;">${escapeHtml(dayLabel)}</h2>`);

        for (const direction of ["morning", "afternoon"] as const) {
          const trip = dayTrips.find((t: any) => t.direction === direction);
          if (!trip) continue;
          const time = formatTime(trip.meeting_time);
          const dirLabel = direction === "morning" ? "Morning" : "Afternoon";
          const tripDrivers = driverAssignments.filter((da: any) => da.trip_id === trip.id);

          rosterHtmlLines.push(`<p style="font-size:14px;margin:4px 0 2px;font-weight:600;color:#118b8c;">${dirLabel} (${time})</p>`);

          if (tripDrivers.length === 0) {
            rosterHtmlLines.push(`<p style="font-size:14px;margin:0 0 8px;padding:8px 12px;background:#fef2f2;border-radius:6px;color:#b91c1c;">⚠️ No driver — trip is uncovered</p>`);
          } else {
            for (const da of tripDrivers) {
              const driver = driverProfileMap.get(da.driver_profile_id);
              const vehicle = vehicleMap.get(da.vehicle_id);
              const kids = tripRidersByDriver.get(da.id) ?? [];
              const driverName = driver?.full_name ?? "A driver";
              const vehicleStr = vehicle?.label ? ` (${vehicle.label})` : "";
              const kidsStr = kids.length > 0 ? ` — ${kids.join(", ")}` : "";
              rosterHtmlLines.push(`<p style="font-size:14px;margin:0 0 4px;">✅ <strong>${escapeHtml(driverName)}</strong>${escapeHtml(vehicleStr)}<br><span style="color:#475569;">${escapeHtml(kidsStr)}</span></p>`);
            }
          }
        }
      }

      const weekLabel = weekStartDate
        ? new Date(weekStartDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric" })
        : "this week";
      emailBodyHtml =
        `<h1 style="font-size:22px;margin:0 0 8px;color:#0c2b52;">Carpool schedule for the week of ${escapeHtml(weekLabel)}</h1>` +
        `<p style="font-size:15px;margin:0 0 16px;color:#0c2b52;">Here's the published carpool schedule. Open the app to see your drives and confirm details.</p>` +
        rosterHtmlLines.join("");

      title = "This week's carpool schedule";
      bodyText = `The schedule for this week has been published. Open the app to see your drives.`;
      tag = `published-${version_id}`;
    } else if (type === "checkin_reminder") {
      // Check-in reminder: sends push + email to unsubmitted households for the
      // nearest upcoming week. The title/body are passed from the cron wrapper
      // (3 slots: Sat 9 AM, 6 PM, 11 PM Pacific). No time gate — the cron fires
      // at the right time. Per-date idempotency key dedupes the off-DST fire.
      const reminderTitle: string = body.title ?? "Check in for next week";
      const reminderBody: string = body.body ?? "Check in for next week.";
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const nowStr = new Date().toISOString();
      const twoDaysStr = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

      const upcomingWeeks = await supaFetch("weeks", "*", [
        ["checkin_deadline", `gte.${nowStr}`],
        ["checkin_deadline", `lte.${twoDaysStr}`],
      ]);

      for (const week of upcomingWeeks) {
        const checkins = await supaFetch("weekly_checkins", "household_id", { week_id: `eq.${week.id}`, status: "eq.submitted" });
        const submittedHouseholds = new Set(checkins.map((c: any) => c.household_id));
        const allMemberships = await supaFetch("memberships", "profile_id,household_id", { group_id: `eq.${week.group_id}`, status: "eq.active" });
        const unsubmitted = allMemberships.filter((m: any) => !submittedHouseholds.has(m.household_id));

        for (const m of unsubmitted) {
          const idempotencyKey = `checkin-reminder-${todayStr}-${m.profile_id}`;
          await sendEmailAndPush(m.profile_id, reminderTitle, reminderBody, idempotencyKey, `checkin-reminder-${todayStr}-${m.profile_id}`);
        }
      }

      return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "processed-inline" });
    } else if (type === "confirmation_reminder") {
      // Confirmation reminder: sends push + email to drivers with tentative
      // assignments. The title/body are passed from the cron wrapper
      // (2 slots: Sun 8 AM, 7 PM Pacific). No time gate — the cron fires at
      // the right time. Per-date idempotency key dedupes the off-DST fire.
      const reminderTitle: string = body.title ?? "Confirm your drives";
      const reminderBody: string = body.body ?? "Confirm your drives.";
      const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const nowStr = new Date().toISOString();
      const tomorrowStr = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const upcomingWeeks = await supaFetch("weeks", "*", [
        ["confirmation_deadline", `gte.${nowStr}`],
        ["confirmation_deadline", `lte.${tomorrowStr}`],
      ]);

      for (const week of upcomingWeeks) {
        const versions = await supaFetch("schedule_versions", "id", { week_id: `eq.${week.id}`, group_id: `eq.${week.group_id}`, status: "in.(draft,published)" });
        for (const version of versions) {
          const assignments = await supaFetch("driver_assignments", "driver_profile_id,trip_id,status", { schedule_version_id: `eq.${version.id}`, status: `eq.tentative` });
          const driverTripCounts = new Map<string, number>();
          for (const a of assignments) {
            driverTripCounts.set(a.driver_profile_id, (driverTripCounts.get(a.driver_profile_id) ?? 0) + 1);
          }

          for (const [driverId, count] of driverTripCounts) {
            const body = count > 1 ? reminderBody.replace("drives", `${count} drives`) : reminderBody.replace("drives", "a drive");
            const idempotencyKey = `confirmation-reminder-${todayStr}-${driverId}`;
            await sendEmailAndPush(driverId, reminderTitle, body, idempotencyKey, `confirmation-reminder-${todayStr}-${driverId}`);
          }
        }
      }

      return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "processed-inline" });
    } else if (type === "assignment_request" && version_id) {
      // Notify drivers with tentative assignments that they have drives to confirm.
      // Fired by generate-schedule Edge Function after writing a draft.
      const assignments = await supaFetch("driver_assignments", "driver_profile_id,trip_id,status", { schedule_version_id: `eq.${version_id}`, status: `eq.tentative` });
      const driverTripCounts = new Map<string, number>();
      for (const a of assignments) {
        driverTripCounts.set(a.driver_profile_id, (driverTripCounts.get(a.driver_profile_id) ?? 0) + 1);
      }

      for (const [driverId, count] of driverTripCounts) {
        const title = count > 1 ? `You're requested to drive ${count} trips` : "You're requested to drive";
        const body = count > 1
          ? `You're requested to drive ${count} trips next week. Open the app to confirm by 7 PM tonight.`
          : `You're requested to drive next week. Open the app to confirm by 7 PM tonight.`;
        const idempotencyKey = `assignment-request-${version_id}-${driverId}`;
        await sendEmailAndPush(driverId, title, body, idempotencyKey, `assignment-request-${version_id}-${driverId}`);
      }

      return jsonResponse({ sent: 0, failed: 0, email_sent: 0, email_failed: 0, reason: "processed-inline" });
    } else if (type === "volunteered" && assignment_id) {
      const riderAssignments = await supaFetch("rider_assignments", "*", { driver_assignment_id: `eq.${assignment_id}` });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      if (childIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const children = await supaFetch("children", "household_id,id", { id: `in.(${childIds.join(",")})` });
      const householdIds = [...new Set(children.map((c: any) => c.household_id))];

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }

      const assignment = await supaFetch("driver_assignments", "*", { id: `eq.${assignment_id}` });
      if (assignment.length > 0) {
        const da = assignment[0];
        // Exclude the volunteering driver from receiving their own coverage push.
        recipientProfileIds = recipientProfileIds.filter((id: string) => id !== da.driver_profile_id);
        const trip = await supaFetch("trips", "*", { id: `eq.${da.trip_id}` });
        if (trip.length > 0) {
          const t = trip[0];
          const period = t.direction === "morning" ? "morning" : "afternoon";
          title = "Drive covered";
          bodyText = `A driver has covered the ${period} trip on ${t.service_date} for your child.`;
          tag = `volunteered-${assignment_id}`;
        }
      }
    } else if (type === "manually_assigned" && assignment_id) {
      const assignment = await supaFetch("driver_assignments", "*", { id: `eq.${assignment_id}` });
      if (assignment.length === 0) return jsonError("Assignment not found", 404);
      const da = assignment[0];

      // Notify the assigned driver only
      recipientProfileIds = [da.driver_profile_id];

      const trip = await supaFetch("trips", "*", { id: `eq.${da.trip_id}` });
      if (trip.length > 0) {
        const t = trip[0];
        const period = t.direction === "morning" ? "morning" : "afternoon";
        title = "You've been assigned";
        bodyText = `The coordinator assigned you to drive the ${period} trip on ${t.service_date}. Open the app to confirm.`;
        tag = `manually-assigned-${assignment_id}`;
      }
    } else if (type === "admin_escalation" && version_id) {
      const versionData = await supaFetch("schedule_versions", "group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id } = versionData[0];
      groupId = group_id;

      // Find uncovered trips in this version
      const driverAssignments = await supaFetch("driver_assignments", "*", { schedule_version_id: `eq.${version_id}`, status: "in.(tentative,confirmed)" });
      const coveredRiderIds = new Set<string>();

      for (const da of driverAssignments) {
        const riders = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: `eq.${da.id}` });
        riders.forEach((r: any) => coveredRiderIds.add(r.child_id));
      }

      const versionRow = await supaFetch("schedule_versions", "week_id", { id: `eq.${version_id}` });
      if (versionRow.length === 0) return jsonError("Version not found", 404);
      const { week_id } = versionRow[0];

      const trips = await supaFetch("trips", "id", { group_id: `eq.${group_id}`, week_id: `eq.${week_id}` });
      const tripIds = trips.map((t: any) => t.id);

      const rideRequests = await supaFetch("ride_requests", "*", {
        trip_id: `in.(${tripIds.join(",")})`,
        needs_ride: "eq.true",
      });
      const uncoveredChildren = rideRequests.filter((rr: any) => !coveredRiderIds.has(rr.child_id));

      if (uncoveredChildren.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      // Notify coordinators only
      const memberships = await supaFetch("memberships", "profile_id", { group_id: `eq.${group_id}`, status: "eq.active", role: "eq.coordinator" });
      recipientProfileIds = memberships.map((m: any) => m.profile_id);

      title = "Schedule needs attention";
      bodyText = `${uncoveredChildren.length} child${uncoveredChildren.length !== 1 ? "ren" : ""} still need${uncoveredChildren.length === 1 ? "s" : ""} a ride this week. Open the app to assign a driver.`;
      tag = `admin-escalation-${version_id}`;
    } else if (type === "displaced" && version_id && Array.isArray(displaced_drivers)) {
      // Each displaced driver gets a personal notification:
      // "You're no longer driving on [day] [morning/afternoon] — the
      // schedule was re-optimized."
      const versionData = await supaFetch("schedule_versions", "group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      groupId = versionData[0].group_id;

      ensureVapid();

      let dSent = 0, dFailed = 0;
      for (const dd of displaced_drivers) {
        const tripData = await supaFetch("trips", "service_date,direction", { id: `eq.${dd.trip_id}` });
        if (tripData.length === 0) continue;
        const t = tripData[0];
        const period = t.direction === "morning" ? "morning" : "afternoon";
        const title = "You're no longer driving";
        const bodyText = `The ${period} trip on ${t.service_date} was re-optimized — you're no longer needed as a driver. Thanks for being available.`;
        const tag = `displaced-${dd.trip_id}-${dd.profile_id}`;

        const subs = await supaFetch("push_subscriptions", "*", { profile_id: `eq.${dd.profile_id}` });
        for (const sub of subs) {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
              { title, body: bodyText, tag, url: "/" },
              { TTL: 2419200 },
            );
            dSent++;
          } catch (error: any) {
            dFailed++;
            const statusCode = error?.statusCode ?? 0;
            if (statusCode === 410 || statusCode === 404) {
              await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
            }
          }
        }

        const profile = await supaFetch("profiles", "email", { id: `eq.${dd.profile_id}` });
        if (profile.length > 0 && profile[0].email && RESEND_API_KEY) {
          const email = profile[0].email;
          if (!isTestEmail(email)) {
            try {
              const cta = APP_URL
                ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
                : "";
              const htmlBody =
                `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;">` +
                `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>` +
                `<p style="font-size:15px;color:#0c2b52;line-height:1.5;">${escapeHtml(bodyText)}</p>` +
                `<p style="margin-top:24px;">${cta}</p></body></html>`;
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${RESEND_API_KEY}`,
                  "Content-Type": "application/json",
                  "Idempotency-Key": `carpool-${tag}-${dd.profile_id}`,
                },
                body: JSON.stringify({
                  from: RESEND_FROM_EMAIL,
                  to: email,
                  subject: title,
                  html: htmlBody,
                }),
              });
            } catch (e) {
              console.error(`[send-push] Displaced email to ${email} failed:`, e);
            }
          }
        }
      }
      return jsonResponse({ sent: dSent, failed: dFailed });
    } else if (type === "driver_on_my_way" && assignment_id) {
      // Driver tapped "I'm on my way" → notify all parents with kids in this car
      const daRows = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,group_id", { id: `eq.${assignment_id}` });
      if (daRows.length === 0) return jsonError("Driver assignment not found", 404);
      const da = daRows[0];

      const tripRows = await supaFetch("trips", "service_date,direction,meeting_time,origin,destination", { id: `eq.${da.trip_id}` });
      if (tripRows.length === 0) return jsonError("Trip not found", 404);
      const trip = tripRows[0];

      const driverRows = await supaFetch("profiles", "id,full_name", { id: `eq.${da.driver_profile_id}` });
      if (driverRows.length === 0) return jsonError("Driver not found", 404);
      const driver = driverRows[0];
      const driverFirst = (driver.full_name ?? "Your driver").split(" ")[0];

      const dirLabel = trip.direction === "morning" ? "morning" : "afternoon";
      const tripDate = new Date(trip.service_date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      const pushTitle = `${driverFirst} is on their way`;
      const pushBody = `The ${dirLabel} pickup is en route for ${tripDate}.`;

      // Recipients: all parents of children in this car (distinct households)
      const riderAssignments = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: `eq.${assignment_id}` });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      let recipientProfileIds: string[] = [];
      if (childIds.length > 0) {
        const children = await supaFetch("children", "household_id", { id: `in.(${childIds.join(",")})` });
        const householdIds = [...new Set(children.map((c: any) => c.household_id))];
        for (const hid of householdIds) {
          const members = await supaFetch("memberships", "profile_id", { household_id: `eq.${hid}`, status: "eq.active" });
          members.forEach((m: any) => recipientProfileIds.push(m.profile_id));
        }
      }
      // Remove the driver themselves — they set the status, no need to notify
      recipientProfileIds = recipientProfileIds.filter((id: string) => id !== da.driver_profile_id);

      title = pushTitle;
      bodyText = pushBody;
      tag = `driver-on-my-way-${assignment_id}`;
      groupId = da.group_id;
    } else if (type === "rider_ready" && assignment_id) {
      // A parent tapped "My kid is ready" → notify the driver
      const childId: string | undefined = body.child_id;
      if (!childId) return jsonError("Missing child_id for rider_ready", 400);

      const daRows = await supaFetch("driver_assignments", "id,trip_id,driver_profile_id,group_id", { id: `eq.${assignment_id}` });
      if (daRows.length === 0) return jsonError("Driver assignment not found", 404);
      const da = daRows[0];

      const tripRows = await supaFetch("trips", "service_date,direction,meeting_time", { id: `eq.${da.trip_id}` });
      if (tripRows.length === 0) return jsonError("Trip not found", 404);
      const trip = tripRows[0];

      const childRows = await supaFetch("children", "first_name,last_name", { id: `eq.${childId}` });
      if (childRows.length === 0) return jsonError("Child not found", 404);
      const child = childRows[0];
      const childFirst = child.first_name;

      const dirLabel = trip.direction === "morning" ? "morning" : "afternoon";
      const pushTitle = `${childFirst} is ready at the curb`;
      const pushBody = `Ready for the ${dirLabel} pickup.`;

      title = pushTitle;
      bodyText = pushBody;
      tag = `rider-ready-${assignment_id}-${childId}`;
      groupId = da.group_id;
      recipientProfileIds = [da.driver_profile_id];
    } else {
      return jsonError(`Invalid type or missing parameters: ${type}`, 400);
    }

    if (recipientProfileIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

    recipientProfileIds = [...new Set(recipientProfileIds)];

    const profileIdsStr = `(${recipientProfileIds.join(",")})`;
    const subscriptions = await supaFetch("push_subscriptions", "*", { profile_id: `in.${profileIdsStr}` });

    // No early return when subscriptions is empty — recipients without a push
    // subscription still get an email. The push loop is a no-op in that case,
    // and the email block below still runs.
    const payload = JSON.stringify({ title, body: bodyText, tag, url: "/" });

    ensureVapid();

    let sent = 0;
    let failed = 0;
    let removed = 0;

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh_key, auth: sub.auth_key },
          },
          payload,
          {
            TTL: 2419200,
          },
        );
        sent++;
      } catch (error: any) {
        failed++;
        const statusCode = error?.statusCode ?? 0;
        // 410 Gone = subscription expired permanently; 404 = endpoint no longer exists
        if (statusCode === 410 || statusCode === 404) {
          console.log(`[send-push] Removing dead subscription (status ${statusCode}): ${sub.endpoint.slice(0, 60)}...`);
          await supaDelete("push_subscriptions", { endpoint: `eq.${encodeURIComponent(sub.endpoint)}` });
          removed++;
        } else {
          console.error(`[send-push] Push failed (status ${statusCode}):`, error?.message ?? error);
        }
      }
    }

    // ── Send emails via Resend ──────────────────────────────
    // Each recipient with an email gets a transactional email. Failures are
    // logged, not thrown — email is best-effort, same pattern as push.
    let emailSent = 0;
    let emailFailed = 0;

    if (RESEND_API_KEY) {
      const profiles = await supaFetch("profiles", "id,email", { id: `in.${profileIdsStr}` });

      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";
      const htmlBody =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;">` +
        `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>` +
        (emailBodyHtml ?? `<p style="font-size:15px;color:#0c2b52;line-height:1.5;">${escapeHtml(bodyText)}</p>`) +
        `<p style="margin-top:24px;">${cta}</p>` +
        `</body></html>`;

      for (const profile of profiles) {
        if (!profile.email) continue;
        if (isTestEmail(profile.email)) continue;
        const idempotencyKey = `carpool-${tag}-${profile.id}`;
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${RESEND_API_KEY}`,
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: profile.email,
              reply_to: RESEND_REPLY_TO,
              subject: title,
              html: htmlBody,
              text: bodyText,
              tags: [
                { name: "type", value: type },
                { name: "group", value: groupId ?? "unknown" },
              ],
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error(`[send-push] Email to ${profile.email} failed:`, err);
            emailFailed++;
          } else {
            emailSent++;
          }
        } catch (e) {
          console.error(`[send-push] Email to ${profile.email} threw:`, e);
          emailFailed++;
        }
      }
    }

    return jsonResponse({ sent, failed, removed, email_sent: emailSent, email_failed: emailFailed });
  } catch (error) {
    return jsonError(error.message ?? "Internal error", 500);
  }
});