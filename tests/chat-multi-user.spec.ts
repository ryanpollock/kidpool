// Multi-user chat e2e: parents in separate concurrent sessions using chat
// the way real humans do — two-way conversations, three-way threads, DM
// back-and-forth with live badges, threads popping into a live inbox,
// realistic content, and the full Crew AI proposal Confirm loop driven
// through the UI (the path the M2 agent depends on).
//
// Run locally:   npm run test:runtime:local -- --grep "Multi-User Chat"
// Run on staging: npm run test:runtime -- --grep "Multi-User Chat"

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID, signInWithTestAuth,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;

const GROUP_ID = PILOT_GROUP_ID;

interface Household {
  userId: string;
  householdId: string;
  email: string;
}

function setupHousehold(n: number, name: string): Household | null {
  const email = `multi-${name.toLowerCase()}@test.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(700 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Multichat') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} Multichat', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function cleanupMultiChatData(): void {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
  } else {
    runSql(`
      DELETE FROM public.chat_threads WHERE group_id = '${GROUP_ID}';
      DELETE FROM public.weeks WHERE id::text LIKE 'deadbeef-%' AND group_id = '${GROUP_ID}';
      DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
      DELETE FROM public.profiles WHERE email LIKE 'multi-%@test.kidpool';
    `);
  }
  deleteAllTestUsers();
}

async function openChatTab(page: Page): Promise<void> {
  await page.getByTestId("nav-chat").click();
  await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
  await expect(page.getByTestId("chat-thread-row").first()).toBeVisible({ timeout: 15_000 });
}

async function openThreadByTitle(page: Page, title: string): Promise<void> {
  await page.locator(".chat-thread-row", { hasText: title }).first().click();
  await expect(page.getByTestId("chat-thread-screen")).toBeVisible();
  await expect(page.locator(".chat-bubble-body, .chat-system-note").first()).toBeVisible({ timeout: 15_000 });
}

async function signInAndWait(page: Page, email: string): Promise<void> {
  await signInWithTestAuth(page, email);
  await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
}

async function sendViaComposer(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").click();
  await page.getByTestId("chat-composer-input").type(text);
  await page.keyboard.press("Enter");
  await expect(page.locator(".chat-bubble-body", { hasText: text.slice(0, 24) }).first()).toBeVisible({ timeout: 15_000 });
}

async function messageBodies(page: Page): Promise<string[]> {
  return page.locator(".chat-bubble-body").allTextContents();
}

// ── Tests ──────────────────────────────────────────────────────────

test("Multi-User Chat: two-way conversation in the Everyone thread", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupMultiChatData();
  const alpha = setupHousehold(40, "Alpha")!;
  const beta = setupHousehold(41, "Bravo")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await signInAndWait(pageA, alpha.email);
    await signInAndWait(pageB, beta.email);
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await openChatTab(pageB);
    await openThreadByTitle(pageB, "Everyone");

    // Alpha sends (via Enter, not the button); Beta sees it arrive live
    await sendViaComposer(pageA, "Hey Bravo — can you take Tuesday morning?");
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Hey Bravo" }).first()).toBeVisible({ timeout: 20_000 });

    // Group threads attribute senders: Bravo sees Alpha's name on the bubble
    await expect(pageB.locator(".chat-bubble-name").filter({ hasText: "Alpha" }).first()).toBeVisible();

    // Bravo replies; Alpha sees the reply arrive live
    await sendViaComposer(pageB, "Yes, Tuesday works for me");
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Tuesday works for me" }).first()).toBeVisible({ timeout: 20_000 });

    // Both sessions agree on the transcript
    const [aBodies, bBodies] = await Promise.all([messageBodies(pageA), messageBodies(pageB)]);
    assert.deepEqual(
      aBodies.map((b) => b.trim()),
      bBodies.map((b) => b.trim()),
      "Both parents must see the identical transcript",
    );
    assert.ok(aBodies.some((b) => b.includes("Hey Bravo")) && aBodies.some((b) => b.includes("Tuesday works")), "Transcript contains both messages");
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupMultiChatData();
  }
});

test("Multi-User Chat: three-way group thread with interleaved sends", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(150_000);

  cleanupMultiChatData();
  const alpha = setupHousehold(42, "Charlie")!;
  const beta = setupHousehold(43, "Delta")!;
  const gamma = setupHousehold(44, "Echo")!;
  assert.ok(alpha && beta && gamma);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const contextC = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const pageC = await contextC.newPage();

  try {
    await signInAndWait(pageA, alpha.email);
    await openChatTab(pageA);

    // Alpha creates the group with Bravo + Echo via the sheet
    await pageA.getByTestId("chat-new-button").click();
    await pageA.getByTestId("chat-new-chat").waitFor();
    await pageA.locator(".chat-newchat-row").first().waitFor({ timeout: 15_000 });
    await pageA.getByTestId(`chat-new-chat-member-${beta.userId}`).click();
    await pageA.getByTestId(`chat-new-chat-member-${gamma.userId}`).click();
    await pageA.getByTestId("chat-new-chat-title").fill("Ride swap crew");
    await pageA.getByTestId("chat-new-chat-start").click();
    await expect(pageA.getByTestId("chat-thread-screen")).toBeVisible();

    // Bravo and Echo join the same thread
    await signInAndWait(pageB, beta.email);
    await openChatTab(pageB);
    await openThreadByTitle(pageB, "Ride swap crew");
    await signInAndWait(pageC, gamma.email);
    await openChatTab(pageC);
    await openThreadByTitle(pageC, "Ride swap crew");

    // Interleaved sends from all three
    await sendViaComposer(pageA, "Message one from Charlie");
    await sendViaComposer(pageB, "Message two from Delta");
    await sendViaComposer(pageC, "Message three from Echo");
    await sendViaComposer(pageA, "Message four from Charlie");

    // All three sessions see the same four messages in chronological order.
    // Realtime delivery lags per session, and a sender's own message appears
    // instantly via the local append while others' messages are still in
    // flight — wait for BOTH trailing messages on every session before
    // comparing transcripts.
    for (const page of [pageA, pageB, pageC]) {
      await expect(page.locator(".chat-bubble-body", { hasText: "Message three from Echo" }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".chat-bubble-body", { hasText: "Message four from Charlie" }).first()).toBeVisible({ timeout: 20_000 });
    }
    for (const page of [pageA, pageB, pageC]) {
      const bodies = (await messageBodies(page)).map((b) => b.trim());
      const filtered = bodies.filter((b) => b.startsWith("Message "));
      assert.deepEqual(
        filtered,
        ["Message one from Charlie", "Message two from Delta", "Message three from Echo", "Message four from Charlie"],
        "Interleaved messages must appear identically in chronological order for every participant",
      );
    }
  } finally {
    await contextA.close();
    await contextB.close();
    await contextC.close();
    cleanupMultiChatData();
  }
});

test("Multi-User Chat: DM back-and-forth with a live badge", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupMultiChatData();
  const alpha = setupHousehold(45, "Foxtrot")!;
  const beta = setupHousehold(46, "Golf")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    // Alpha signs in, then DMs Bravo from the parent directory
    await signInAndWait(pageA, alpha.email);
    await pageA.getByTestId("directory-link").click();
    await expect(pageA.getByTestId("directory-screen")).toBeVisible();
    await pageA.getByTestId(`directory-parent-${beta.userId}`).click();
    await expect(pageA.getByTestId("parent-detail-screen")).toBeVisible();
    await pageA.getByTestId("parent-detail-message").click();
    await expect(pageA.getByTestId("chat-thread-screen")).toBeVisible();

    // Bravo signs in on Home; Alpha's message lights the badge live
    await signInAndWait(pageB, beta.email);
    await expect(pageB.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });
    await sendViaComposer(pageA, "Ping — quick question about Thursday");
    const badge = pageB.getByTestId("nav-chat").locator(".nav-badge");
    await expect(badge).toBeVisible({ timeout: 20_000 });

    // Bravo opens the DM from the inbox and sees the message
    await openChatTab(pageB);
    const dmRow = pageB.locator(".chat-thread-row", { hasText: "Foxtrot" }).first();
    await expect(dmRow.getByTestId("chat-unread-badge")).toBeVisible();
    await dmRow.click();
    await expect(pageB.locator(".chat-bubble-body", { hasText: "quick question about Thursday" }).first()).toBeVisible({ timeout: 15_000 });

    // Bravo replies; Alpha sees it arrive live in the open thread
    await sendViaComposer(pageB, "Ask away — I'm free Thursday");
    await expect(pageA.locator(".chat-bubble-body", { hasText: "free Thursday" }).first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupMultiChatData();
  }
});

test("Multi-User Chat: a new DM pops into a live inbox", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupMultiChatData();
  const alpha = setupHousehold(47, "Hotel")!;
  const beta = setupHousehold(48, "India")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    // Bravo sits on the Chat inbox, doing nothing
    await signInAndWait(pageB, beta.email);
    await openChatTab(pageB);
    await expect(pageB.locator(".chat-thread-row", { hasText: "Everyone" }).first()).toBeVisible();
    const rowsBefore = await pageB.getByTestId("chat-thread-row").count();

    // Alpha starts a DM with Bravo — the row must appear in Bravo's live
    // inbox (realtime), carrying an unread badge for the disclosure note.
    await signInAndWait(pageA, alpha.email);
    await pageA.getByTestId("directory-link").click();
    await pageA.getByTestId(`directory-parent-${beta.userId}`).click();
    await pageA.getByTestId("parent-detail-message").click();
    await expect(pageA.getByTestId("chat-thread-screen")).toBeVisible();

    const newRow = pageB.locator(".chat-thread-row", { hasText: "Hotel" }).first();
    await expect(newRow).toBeVisible({ timeout: 20_000 });

    // The disclosure note shares the enrollment transaction timestamp and is
    // never unread — a real first message is what makes the badge appear.
    await sendViaComposer(pageA, "Hello India — quick ride question");
    await expect(newRow.getByTestId("chat-unread-badge")).toBeVisible({ timeout: 20_000 });
    assert.equal(await pageB.getByTestId("chat-thread-row").count(), rowsBefore + 1, "Exactly one new thread row appeared");
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupMultiChatData();
  }
});

test("Multi-User Chat: emoji, long messages, bursts, and Shift+Enter newlines", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupMultiChatData();
  const alpha = setupHousehold(49, "Juliet")!;
  const beta = setupHousehold(50, "Kilo")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await signInAndWait(pageA, alpha.email);
    await signInAndWait(pageB, beta.email);
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await openChatTab(pageB);
    await openThreadByTitle(pageB, "Everyone");

    // Emoji
    await sendViaComposer(pageA, "Carpool tomorrow? 👍🚗");
    // Multiline via Shift+Enter — one message, embedded newline
    const input = pageA.getByTestId("chat-composer-input");
    await input.type("Pickup at 8:40");
    await pageA.keyboard.down("Shift");
    await pageA.keyboard.press("Enter");
    await pageA.keyboard.up("Shift");
    await input.type("then school by 9:00");
    await pageA.keyboard.press("Enter");
    await pageA.waitForTimeout(1_000);
    // Rapid burst of three
    await sendViaComposer(pageA, "Burst one");
    await sendViaComposer(pageA, "Burst two");
    await sendViaComposer(pageA, "Burst three");
    // Long wrapping message
    const long = `Heads up for the rest of the week: ${"we have a conflicting morning schedule on Wednesday and Friday, so we may need to shuffle the pickup order. ".repeat(3)}Thanks all!`;
    await sendViaComposer(pageA, long);

    // Bravo sees every message, in order, with the multiline intact.
    // Wait for the actual LAST message (the long one) before comparing.
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Heads up for the rest" }).first()).toBeVisible({ timeout: 20_000 });
    const bodies = (await messageBodies(pageB)).map((b) => b);
    const markers = ["Carpool tomorrow? 👍🚗", "Pickup at 8:40\nthen school by 9:00", "Burst one", "Burst two", "Burst three", long.slice(0, 24)];
    let cursor = 0;
    for (const marker of markers) {
      const at = bodies.findIndex((b, i) => i >= cursor && b.includes(marker.slice(0, 24)));
      assert.ok(at !== -1, `Message ${JSON.stringify(marker.slice(0, 24))} must arrive in order — got: ${JSON.stringify(bodies)}`);
      cursor = at + 1;
    }
    const multiline = bodies.find((b) => b.includes("Pickup at 8:40"));
    assert.ok(multiline?.includes("\n"), "Shift+Enter must keep the newline inside one message");
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupMultiChatData();
  }
});

test("Multi-User Chat: proposal Confirm executes the schedule change via the UI", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(180_000);

  cleanupMultiChatData();
  const coord = setupHousehold(51, "Mike")!;
  const driver = setupHousehold(52, "November")!;
  const rider = setupHousehold(53, "Oscar")!;
  assert.ok(coord && driver && rider);
  const WEEK_ID = UID(960);
  const TRIP_ID = UID(961);
  const VEHICLE_ID = UID(962);
  const CHILD_D = UID(963);
  const CHILD_R = UID(964);
  const CHECK_D = UID(965);
  const CHECK_R = UID(966);
  const PROPOSAL_ID = UID(967);

  try {
    // ── Schedule fixtures (the reassignment.spec pattern, trimmed) ──
    runSql(`
      UPDATE public.memberships SET role = 'coordinator' WHERE profile_id = '${coord.userId}' AND group_id = '${GROUP_ID}';
      INSERT INTO public.vehicles (id, group_id, household_id, label, child_passenger_capacity, active, created_by) VALUES ('${VEHICLE_ID}', '${GROUP_ID}', '${driver.householdId}', 'ConfirmCar', 4, true, '${driver.userId}');
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${CHILD_D}', '${GROUP_ID}', '${driver.householdId}', 'Nova', 'Kid', '${driver.userId}');
      INSERT INTO public.children (id, group_id, household_id, first_name, last_name, created_by) VALUES ('${CHILD_R}', '${GROUP_ID}', '${rider.householdId}', 'Otto', 'Kid', '${rider.userId}');
      INSERT INTO public.weeks (id, group_id, starts_on, status) VALUES ('${WEEK_ID}', '${GROUP_ID}', '2028-01-03', 'open');
      INSERT INTO public.trips (id, group_id, week_id, service_date, direction, meeting_time, departure_time, origin, destination) VALUES ('${TRIP_ID}', '${GROUP_ID}', '${WEEK_ID}', '2028-01-03', 'morning', '08:40', '08:45', 'Midtown', 'Presidio');
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${CHECK_D}', '${GROUP_ID}', '${WEEK_ID}', '${driver.householdId}', 'submitted', 5);
      INSERT INTO public.weekly_checkins (id, group_id, week_id, household_id, status, max_drives) VALUES ('${CHECK_R}', '${GROUP_ID}', '${WEEK_ID}', '${rider.householdId}', 'submitted', 5);
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${CHECK_D}', '${TRIP_ID}', '${CHILD_D}', true, '${driver.userId}');
      INSERT INTO public.ride_requests (group_id, checkin_id, trip_id, child_id, needs_ride, created_by) VALUES ('${GROUP_ID}', '${CHECK_R}', '${TRIP_ID}', '${CHILD_R}', true, '${rider.userId}');
      INSERT INTO public.driver_availability (group_id, checkin_id, trip_id, driver_profile_id, vehicle_id, preference) VALUES ('${GROUP_ID}', '${CHECK_D}', '${TRIP_ID}', '${driver.userId}', '${VEHICLE_ID}', 'prefer');
    `);

    // Generate + publish the schedule via the Edge Function
    const tokenBody = JSON.stringify({ email: coord.email, password: "TestPass123!" });
    const jwt = JSON.parse(execSync(
      `curl -s -X POST -H "apikey: ${env.anonKey}" -H "Content-Type: application/json" -d '${tokenBody}' "${env.supabaseUrl}/auth/v1/token?grant_type=password"`,
      { encoding: "utf8" },
    )).access_token;
    const gen = JSON.parse(execSync(
      `curl -s -X POST -H "Authorization: Bearer ${jwt}" -H "apikey: ${env.anonKey}" -H "Content-Type: application/json" -d '{"weekId":"${WEEK_ID}"}' "${env.supabaseUrl}/functions/v1/generate-schedule"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ));
    assert.ok(gen.success, "Schedule generation should succeed");
    runSql(`
      UPDATE public.driver_assignments SET status = 'confirmed' WHERE schedule_version_id IN (SELECT id FROM public.schedule_versions WHERE week_id = '${WEEK_ID}' AND status = 'draft');
      UPDATE public.schedule_versions SET status = 'published', published_at = now() WHERE week_id = '${WEEK_ID}' AND status = 'draft';
    `);
    const assignment = (runSql(`
      SELECT da.id FROM public.driver_assignments da JOIN public.schedule_versions sv ON sv.id = da.schedule_version_id
      WHERE sv.week_id = '${WEEK_ID}' AND da.driver_profile_id = '${driver.userId}' LIMIT 1;
    `).rows ?? [])[0] as { id: string } | undefined;
    assert.ok(assignment, "Driver assignment should exist after generation");
    const riderAssignmentCount = (runSql(`
      SELECT count(*)::int AS n FROM public.rider_assignments WHERE driver_assignment_id = '${assignment!.id}' AND child_id = '${CHILD_R}';
    `).rows ?? [])[0] as { n: number };
    assert.equal(riderAssignmentCount.n, 1, "Rider's child is assigned before the proposal");

    // ── The rider opens Chat (ensuring the everyone thread), then the M2
    // agent's proposal is simulated with a service-role insert ──
    const contextRider = await browser.newContext();
    const pageRider = await contextRider.newPage();
    await signInAndWait(pageRider, rider.email);
    await openChatTab(pageRider);
    await openThreadByTitle(pageRider, "Everyone");
    const threadId = (runSql(`
      SELECT id FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'everyone' LIMIT 1;
    `).rows ?? [])[0] as { id: string };
    runSql(`
      INSERT INTO public.chat_proposals (id, group_id, thread_id, kind, params, summary, required_confirmer_profile_id, status)
      VALUES ('${PROPOSAL_ID}', '${GROUP_ID}', '${threadId.id}', 'cancel_ride',
        jsonb_build_object('child_id', '${CHILD_R}', 'driver_assignment_id', '${assignment!.id}'),
        'Cancel Otto Kid Monday morning ride', '${rider.userId}', 'pending');
      INSERT INTO public.chat_messages (thread_id, sender_kind, sender_name, body, proposal_id)
      VALUES ('${threadId.id}', 'agent', 'Crew AI', 'I can cancel Otto Kid Monday morning ride. Tap confirm and I will make it happen.', '${PROPOSAL_ID}');
    `);

    // The card renders for the required confirmer with a live Confirm button
    await expect(pageRider.getByTestId("chat-proposal-card")).toBeVisible({ timeout: 20_000 });
    await pageRider.getByTestId("chat-proposal-confirm").click();

    // Confirmation flips the card and posts the agent's Done note
    await expect(pageRider.locator(".chat-proposal-status--executed")).toBeVisible({ timeout: 20_000 });
    await expect(pageRider.locator(".chat-bubble-body", { hasText: "Done — Cancel Otto Kid" }).first()).toBeVisible({ timeout: 20_000 });

    // The schedule actually changed, exactly once
    const after = (runSql(`
      SELECT
        (SELECT count(*)::int FROM public.rider_assignments WHERE driver_assignment_id = '${assignment!.id}' AND child_id = '${CHILD_R}') AS rider_rows,
        (SELECT count(*)::int FROM public.ride_requests WHERE child_id = '${CHILD_R}' AND trip_id = '${TRIP_ID}' AND needs_ride) AS still_needs,
        (SELECT status FROM public.chat_proposals WHERE id = '${PROPOSAL_ID}') AS status;
    `).rows ?? [])[0] as { rider_rows: number; still_needs: number; status: string };
    assert.equal(after.rider_rows, 0, "Confirm must delete the rider assignment");
    assert.equal(after.still_needs, 0, "Confirm must clear needs_ride");
    assert.equal(after.status, "executed");
    await contextRider.close();

    // A non-confirmer sees the executed card with NO action buttons
    const contextDriver = await browser.newContext();
    const pageDriver = await contextDriver.newPage();
    await signInAndWait(pageDriver, driver.email);
    await openChatTab(pageDriver);
    await openThreadByTitle(pageDriver, "Everyone");
    await expect(pageDriver.locator(".chat-proposal-status--executed")).toBeVisible({ timeout: 20_000 });
    assert.equal(await pageDriver.getByTestId("chat-proposal-confirm").count(), 0, "Executed proposals must not offer Confirm to anyone");
    assert.equal(await pageDriver.getByTestId("chat-proposal-decline").count(), 0, "Executed proposals must not offer Decline to anyone");
    await contextDriver.close();
  } finally {
    cleanupMultiChatData();
  }
});