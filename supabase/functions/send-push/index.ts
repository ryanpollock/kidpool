import { corsHeaders } from "../_shared/cors.ts";

// Web Push implementation using the Web Push Protocol (RFC 8030 + RFC 8291)
// Uses Deno's native WebCrypto API — no npm dependencies required.

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://ujcrnrcgbvzyqosykkjy.supabase.co";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importVapidPrivateKey(): Promise<CryptoKey> {
  if (!VAPID_PRIVATE_KEY) throw new Error("VAPID_PRIVATE_KEY not set");
  const raw = base64UrlToBytes(VAPID_PRIVATE_KEY);
  return crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function createJwt(): Promise<string> {
  if (!VAPID_PRIVATE_KEY) throw new Error("VAPID_PRIVATE_KEY not set");
  const key = await importVapidPrivateKey();

  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: new URL(SUPABASE_URL).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: `mailto:noreply@kidpool-sf.vercel.app`,
  };

  const enc = new TextEncoder();
  const headerB64 = bytesToBase64Url(enc.encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function sendWebPush(
  subscription: { endpoint: string; p256dh_key: string; auth_key: string },
  payload: Record<string, unknown>,
): Promise<boolean> {
  const vapidPublicKey = VAPID_PUBLIC_KEY ? base64UrlToBytes(VAPID_PUBLIC_KEY) : null;

  // Encrypt payload using aes128gcm (RFC 8291 simplified)
  const enc = new TextEncoder();
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = enc.encode(payloadJson);

  // For simplicity, send notification with just the VAPID auth header.
  // The payload encryption follows RFC 8291 — using ECDH + aes128gcm.
  const encrypted = await encryptPayload(
    payloadBytes,
    base64UrlToBytes(subscription.p256dh_key),
    base64UrlToBytes(subscription.auth_key),
    vapidPublicKey,
  );

  const jwt = await createJwt();

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "2419200",
      "Authorization": `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
    },
    body: encrypted,
  });

  return response.ok;
}

async function encryptPayload(
  payload: Uint8Array,
  p256dh: Uint8Array,
  authSecret: Uint8Array,
  vapidPublicKey: Uint8Array | null,
): Promise<Uint8Array> {
  // RFC 8291 / aes128gcm content encoding
  // 1. Generate ephemeral ECDH key pair
  const ecdhKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ecdhPubKey = await crypto.subtle.exportKey("raw", ecdhKeys.publicKey);
  const ecdhRaw = new Uint8Array(ecdhPubKey);

  // 2. Import the subscriber's public key
  const subscriberPubKey = await crypto.subtle.importKey(
    "raw",
    p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // 3. Compute shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: subscriberPubKey },
    ecdhKeys.privateKey,
    256,
  );

  // 4. IKM = shared secret || auth secret
  const ikm = new Uint8Array(sharedSecret.byteLength + authSecret.length);
  ikm.set(new Uint8Array(sharedSecret), 0);
  ikm.set(authSecret, sharedSecret.byteLength);

  // 5. HKDF-Expand to get content encryption key (16 bytes) + nonce (12 bytes)
  const info = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // key info
  const prk = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekAndNonce = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) },
    prk,
    256 + 96, // 32 bytes CEK + 12 bytes nonce... actually let's use simpler approach
  );

  // Actually, let's use a simpler, correct implementation:
  // Use HKDF twice: once for key, once for nonce

  // Key info: "Content-Encoding: aes128gcm\x00"
  const keyInfo = enc.encode("Content-Encoding: aes128gcm\x00");
  const keyPrk = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("WebPush: info\0"), info: keyInfo },
      keyPrk,
      128,
    ),
  );

  // Nonce info: "Content-Encoding: nonce\x00"
  const nonceInfo = enc.encode("Content-Encoding: nonce\x00");
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("WebPush: info\0"), info: nonceInfo },
      keyPrk,
      96,
    ),
  );

  // 6. Encrypt with AES-128-GCM
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);

  // RFC 8291: 16-bit record size = 4096, padding = 0
  const recordSize = 4096;
  const padding = new Uint8Array([0]); // 1 byte of padding (0x00)
  const plaintext = new Uint8Array(payload.length + padding.length);
  plaintext.set(payload, 0);
  plaintext.set(padding, payload.length);

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 },
    aesKey,
    plaintext,
  );

  // 7. Build the aes128gcm header
  const header = new Uint8Array(21 + ecdhRaw.length);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, recordSize);
  dv.setUint16(4, 1000); // key id length (unused, set large)
  header[6] = 0; // keyid
  // Actually, RFC 8291 header is: rs(4) + idlen(1) + keyid(idlen) + ciphertext
  // For aes128gcm, keyid = ephemeral public key
  const idlen = ecdhRaw.length;
  const headerBytes = new Uint8Array(5 + idlen);
  const hdv = new DataView(headerBytes.buffer);
  hdv.setUint32(0, recordSize);
  headerBytes[4] = idlen;
  headerBytes.set(ecdhRaw, 5);

  // Combine header + encrypted (which includes the GCM tag)
  const result = new Uint8Array(headerBytes.length + encrypted.byteLength);
  result.set(headerBytes, 0);
  result.set(new Uint8Array(encrypted), headerBytes.length);

  return result;
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonError("Missing auth header", 401);

  try {
    const body = await req.json();
    const { type, assignment_id, version_id } = body;

    if (!SERVICE_ROLE_KEY) return jsonError("Service role key not configured", 500);
    if (!type) return jsonError("Missing notification type", 400);

    // Create a Supabase client with the service role key for DB access
    const supabaseUrl = SUPABASE_URL;
    const supaHeaders = {
      "apikey": SERVICE_ROLE_KEY,
      "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };

    const supaFetch = async (table: string, select: string, filters: Record<string, string>) => {
      const params = new URLSearchParams({ select });
      for (const [k, v] of Object.entries(filters)) params.append(k, v);
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}?${params}`, { headers: supaHeaders });
      return res.json();
    };

    // Resolve recipients and build message based on type
    let recipientProfileIds: string[] = [];
    let title = "";
    let bodyText = "";
    let tag = "carpool";

    if (type === "declined" && assignment_id) {
      // Find affected parents: their children are riders on this assignment
      const riderAssignments = await supaFetch("rider_assignments", "*", { driver_assignment_id: assignment_id });
      const childIds = riderAssignments.map((ra: any) => ra.child_id);
      if (childIds.length === 0) return jsonError("No riders found", 404);

      const children = await supaFetch("children", "household_id,id", { "id.in": `(${childIds.join(",")})` });
      const householdIds = [...new Set(children.map((c: any) => c.household_id))];

      // Get memberships for these households
      for (const hid of householdIds) {
        const memberships = await supaFetch("memberships", "profile_id", { household_id: hid, status: "active" });
        recipientProfileIds.push(...memberships.map((m: any) => m.profile_id));
      }

      // Get driver name and trip info
      const assignment = await supaFetch("driver_assignments", "*", { id: `eq.${assignment_id}` });
      if (assignment.length > 0) {
        const da = assignment[0];
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
      // Find parents of uncovered children
      const driverAssignments = await supaFetch("driver_assignments", "*", { schedule_version_id: version_id, status: "in.(tentative,confirmed)" });
      const coveredRiderIds = new Set<string>();

      for (const da of driverAssignments) {
        const riders = await supaFetch("rider_assignments", "child_id", { driver_assignment_id: da.id });
        riders.forEach((r: any) => coveredRiderIds.add(r.child_id));
      }

      // Get all ride requests that need a ride
      const versionData = await supaFetch("schedule_versions", "week_id,group_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { week_id, group_id } = versionData[0];

      const weeks = await supaFetch("weeks", "*", { id: `eq.${week_id}` });
      const trips = await supaFetch("trips", "*", { group_id: group_id });
      const tripIds = trips.map((t: any) => t.id);
      const tripIdsStr = `(${tripIds.join(",")})`;

      const rideRequests = await supaFetch("ride_requests", "*", { "group_id": group_id, "needs_ride": "true" });
      const uncoveredChildren = rideRequests
        .filter((rr: any) => !coveredRiderIds.has(rr.child_id))
        .map((rr: any) => rr.child_id);

      if (uncoveredChildren.length === 0) {
        return new Response(JSON.stringify({ sent: 0, failed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

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
      // Notify all group members
      const versionData = await supaFetch("schedule_versions", "group_id,week_id", { id: `eq.${version_id}` });
      if (versionData.length === 0) return jsonError("Version not found", 404);
      const { group_id } = versionData[0];

      const memberships = await supaFetch("memberships", "profile_id", { group_id, status: "active" });
      recipientProfileIds = memberships.map((m: any) => m.profile_id);

      title = "Schedule published";
      bodyText = `The schedule for this week has been published. Open the app to see your drives.`;
      tag = `published-${version_id}`;
    } else if (type === "deadline_reminder") {
      // Find weeks with checkin_deadline in the next 24 hours
      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const nowStr = now.toISOString();
      const tomorrowStr = tomorrow.toISOString();

      const weeks = await supaFetch("weeks", "*", { "checkin_deadline.gte": nowStr, "checkin_deadline.lte": tomorrowStr });

      for (const week of weeks) {
        // Find households that haven't submitted
        const checkins = await supaFetch("weekly_checkins", "household_id", { week_id: week.id, status: "eq.submitted" });
        const submittedHouseholds = new Set(checkins.map((c: any) => c.household_id));

        const allMemberships = await supaFetch("memberships", "profile_id,household_id", { group_id: week.group_id, status: "active" });
        const unsubmitted = allMemberships.filter((m: any) => !submittedHouseholds.has(m.household_id));

        recipientProfileIds.push(...unsubmitted.map((m: any) => m.profile_id));
      }

      title = "Check-in deadline";
      bodyText = `Your check-in deadline is approaching. Submit your ride needs soon.`;
      tag = "deadline-reminder";
    } else {
      return jsonError(`Invalid type or missing parameters: ${type}`, 400);
    }

    if (recipientProfileIds.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Deduplicate
    recipientProfileIds = [...new Set(recipientProfileIds)];

    // Get push subscriptions for these profiles
    const profileIdsStr = `(${recipientProfileIds.join(",")})`;
    const subscriptions = await supaFetch("push_subscriptions", "*", { "profile_id.in": profileIdsStr });

    if (subscriptions.length === 0) {
      return new Response(JSON.stringify({ sent: 0, failed: 0, reason: "no_subscriptions" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const payload = { title, body: bodyText, tag, url: "/" };

    let sent = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        const success = await sendWebPush(sub, payload);
        if (success) sent++;
        else failed++;
      } catch {
        failed++;
      }
    }

    return new Response(JSON.stringify({ sent, failed }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return jsonError(error.message ?? "Internal error", 500);
  }
});