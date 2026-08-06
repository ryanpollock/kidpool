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

async function supaFetch(table: string, select: string, filters: Record<string, string>) {
  const params = new URLSearchParams({ select });
  for (const [k, v] of Object.entries(filters)) params.append(k, v);
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
    const { type, assignment_id, version_id } = body;

    if (!SERVICE_ROLE_KEY) return jsonError("Service role key not configured", 500);
    if (!type) return jsonError("Missing notification type", 400);

    let recipientProfileIds: string[] = [];
    let title = "";
    let bodyText = "";
    let tag = "carpool";
    let groupId: string | null = null;

    if (type === "declined" && assignment_id) {
      const riderAssignments = await supaFetch("rider_assignments", "*", { driver_assignment_id: assignment_id });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      if (childIds.length === 0) return jsonError("No riders found", 404);

      const children = await supaFetch("children", "household_id,id", { "id.in": `(${childIds.join(",")})` });
      const householdIds = [...new Set(children.map((c: any) => c.household_id))];

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: hid, status: "active" });
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
      const driverAssignments = await supaFetch("driver_assignments", "*", { schedule_version_id: version_id, status: "in.(tentative,confirmed)" });
      const coveredRiderIds = new Set<string>();

      for (const da of driverAssignments) {
        const riders = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: da.id });
        riders.forEach((r: any) => coveredRiderIds.add(r.child_id));
      }

      const versionData = await supaFetch("schedule_versions", "week_id,group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id, week_id } = versionData[0];
      groupId = group_id;

      // Scope ride_requests to this version's week only — not the whole group.
      // Without scoping, families get false "your child doesn't have a ride"
      // pushes for weeks they haven't checked in for yet.
      const trips = await supaFetch("trips", "id", { group_id, week_id });
      const tripIds = trips.map((t: any) => t.id);
      if (tripIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const rideRequests = await supaFetch("ride_requests", "*", {
        trip_id: `in.(${tripIds.join(",")})`,
        needs_ride: "true",
      });
      const uncoveredChildren = rideRequests
        .filter((rr: any) => !coveredRiderIds.has(rr.child_id))
        .map((rr: any) => rr.child_id);

      if (uncoveredChildren.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const children = await supaFetch("children", "id,household_id", { "id.in": `(${uncoveredChildren.join(",")})` });
      const childMap = new Map(children.map((c: any) => [c.id, c.household_id]));
      const householdIds = new Set<string>();
      for (const cid of uncoveredChildren) {
        const hid = childMap.get(cid);
        if (hid) householdIds.add(hid);
      }

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: hid, status: "active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }

      title = "Ride needed";
      bodyText = `Your child doesn't have a ride assigned for this week. Check the schedule or contact the admin.`;
      tag = `uncovered-${version_id}`;
    } else if (type === "published" && version_id) {
      const versionData = await supaFetch("schedule_versions", "group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id } = versionData[0];
      groupId = group_id;

      const memberships = await supaFetch("memberships", "profile_id", { group_id, status: "active" });
      recipientProfileIds = memberships.map((m: any) => m.profile_id);

      title = "Schedule published";
      bodyText = `The schedule for this week has been published. Open the app to see your drives.`;
      tag = `published-${version_id}`;
    } else if (type === "deadline_reminder") {
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const nowStr = now.toISOString();
      const tomorrowStr = tomorrow.toISOString();

      const weeks = await supaFetch("weeks", "*", { "checkin_deadline.gte": nowStr, "checkin_deadline.lte": tomorrowStr });

      for (const week of weeks) {
        const checkins = await supaFetch("weekly_checkins", "household_id", { week_id: week.id, status: "eq.submitted" });
        const submittedHouseholds = new Set(checkins.map((c: any) => c.household_id));

        const allMemberships = await supaFetch("memberships", "profile_id,household_id", { group_id: week.group_id, status: "active" });
        const unsubmitted = allMemberships.filter((m: any) => !submittedHouseholds.has(m.household_id));
        recipientProfileIds.push(...unsubmitted.map((m: any) => m.profile_id));
      }

      title = "Check-in deadline";
      bodyText = `Your check-in deadline is approaching. Submit your ride needs soon.`;
      tag = "deadline-reminder";
    } else if (type === "volunteered" && assignment_id) {
      const riderAssignments = await supaFetch("rider_assignments", "*", { driver_assignment_id: assignment_id });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      if (childIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      const children = await supaFetch("children", "household_id,id", { "id.in": `(${childIds.join(",")})` });
      const householdIds = [...new Set(children.map((c: any) => c.household_id))];

      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: hid, status: "active" });
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
      const driverAssignments = await supaFetch("driver_assignments", "*", { schedule_version_id: version_id, status: "in.(tentative,confirmed)" });
      const coveredRiderIds = new Set<string>();

      for (const da of driverAssignments) {
        const riders = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: da.id });
        riders.forEach((r: any) => coveredRiderIds.add(r.child_id));
      }

      const versionRow = await supaFetch("schedule_versions", "week_id", { id: `eq.${version_id}` });
      if (versionRow.length === 0) return jsonError("Version not found", 404);
      const { week_id } = versionRow[0];

      const trips = await supaFetch("trips", "id", { group_id, week_id });
      const tripIds = trips.map((t: any) => t.id);

      const rideRequests = await supaFetch("ride_requests", "*", {
        trip_id: `in.(${tripIds.join(",")})`,
        needs_ride: "true",
      });
      const uncoveredChildren = rideRequests.filter((rr: any) => !coveredRiderIds.has(rr.child_id));

      if (uncoveredChildren.length === 0) return jsonResponse({ sent: 0, failed: 0 });

      // Notify coordinators only
      const memberships = await supaFetch("memberships", "profile_id", { group_id, status: "active", role: "eq.coordinator" });
      recipientProfileIds = memberships.map((m: any) => m.profile_id);

      title = "Schedule needs attention";
      bodyText = `${uncoveredChildren.length} child${uncoveredChildren.length !== 1 ? "ren" : ""} still need${uncoveredChildren.length === 1 ? "s" : ""} a ride this week. Open the app to assign a driver.`;
      tag = `admin-escalation-${version_id}`;
    } else {
      return jsonError(`Invalid type or missing parameters: ${type}`, 400);
    }

    if (recipientProfileIds.length === 0) return jsonResponse({ sent: 0, failed: 0 });

    recipientProfileIds = [...new Set(recipientProfileIds)];

    const profileIdsStr = `(${recipientProfileIds.join(",")})`;
    const subscriptions = await supaFetch("push_subscriptions", "*", { "profile_id.in": profileIdsStr });

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
      const profiles = await supaFetch("profiles", "id,email", { "id.in": profileIdsStr });

      const cta = APP_URL
        ? `<a href="${APP_URL}" style="display:inline-block;background:#118b8c;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Open the app</a>`
        : "";
      const htmlBody =
        `<!DOCTYPE html><html><body style="font-family:-apple-system,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;">` +
        `<h1 style="font-size:18px;color:#0c2b52;margin:0 0 16px;">Carpool Crew</h1>` +
        `<p style="font-size:15px;color:#0c2b52;line-height:1.5;">${escapeHtml(bodyText)}</p>` +
        `<p style="margin-top:24px;">${cta}</p>` +
        `</body></html>`;

      for (const profile of profiles) {
        if (!profile.email) continue;
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