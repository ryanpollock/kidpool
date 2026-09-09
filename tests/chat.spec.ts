// E2E tests for the chat feature: the Chat tab, everyone thread, DMs from
// the parent directory, group creation via the new-chat sheet, live message
// delivery over Supabase Realtime, and the Crew AI proposal card flow.
//
// Run locally:   npm run test:runtime:local -- --grep "Chat"
// Run on staging: npm run test:runtime -- --grep "Chat"

import assert from "node:assert/strict";
import { expect, test, type Page } from "@playwright/test";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID, TEST_PASSWORD, signInWithTestAuth,
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
  const email = `chat-${name.toLowerCase()}@test.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(700 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Chatty') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} ChatHousehold', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, householdId, email };
}

function cleanupChatData(): void {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
  } else {
    runSql(`
      DELETE FROM public.chat_threads WHERE group_id = '${GROUP_ID}';
      DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
      DELETE FROM public.profiles WHERE email LIKE 'chat-%@test.kidpool';
    `);
  }
  deleteAllTestUsers();
}

async function openChatTab(page: Page): Promise<void> {
  await page.getByTestId("nav-chat").click();
  await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
  // ensure_everyone_thread + inbox load
  await expect(page.getByTestId("chat-thread-row").first()).toBeVisible({ timeout: 15_000 });
}

async function openThreadByTitle(page: Page, title: string): Promise<void> {
  await page.locator(".chat-thread-row", { hasText: title }).first().click();
  await expect(page.getByTestId("chat-thread-screen")).toBeVisible();
}

// ── Tests ──────────────────────────────────────────────────────────

test("Chat: everyone thread exists with disclosure; parents can send messages", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(1, "Alpha")!;
  const beta = setupHousehold(2, "Beta")!;
  assert.ok(alpha && beta);

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });

    await openChatTab(page);

    // The everyone thread is pinned with the All-parents badge
    const everyoneRow = page.locator(".chat-thread-row", { hasText: "Everyone" }).first();
    await expect(everyoneRow).toBeVisible();

    await everyoneRow.click();
    await expect(page.getByTestId("chat-thread-screen")).toBeVisible();

    // Disclosure system note mentions Crew AI
    await expect(page.getByTestId("chat-system-note").first()).toContainText("Crew AI");

    // Geometry guard: the first message must sit fully below the thread
    // header. Regression: prototype.css's .subpage-header collision wrapped
    // the mute bell onto a second grid row, overlaying the message list.
    await page.locator(".chat-system-note").first().waitFor({ timeout: 10_000 });
    const geometry = await page.evaluate(() => {
      const header = document.querySelector(".chat-thread-header")?.getBoundingClientRect();
      const note = document.querySelector(".chat-system-note")?.getBoundingClientRect();
      const bell = document.querySelector('[data-testid="chat-mute-button"]')?.getBoundingClientRect();
      return { headerBottom: header?.bottom ?? 0, noteTop: note?.top ?? 0, bellBottom: bell?.bottom ?? 0, headerBottomEdge: header?.bottom ?? 0 };
    });
    assert.ok(
      geometry.noteTop >= geometry.headerBottom + 8,
      `First message must clear the header by 8px+ (note top ${geometry.noteTop.toFixed(1)}, header bottom ${geometry.headerBottom.toFixed(1)})`,
    );
    assert.ok(
      geometry.bellBottom <= geometry.headerBottom + 1,
      `Bell must stay inside the header row (bell bottom ${geometry.bellBottom.toFixed(1)}, header bottom ${geometry.headerBottom.toFixed(1)})`,
    );

    // Send a message
    await page.getByTestId("chat-composer-input").fill("Testing the group chat");
    await page.getByTestId("chat-send-button").click();
    await expect(page.locator(".chat-bubble-body", { hasText: "Testing the group chat" }).first()).toBeVisible();

    // Back to the inbox; the preview shows the new message
    await page.getByTestId("chat-thread-back").click();
    await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
    await expect(page.locator(".chat-thread-preview").first()).toContainText("Testing the group chat");
  } finally {
    cleanupChatData();
  }
});

test("Chat: second parent sees unread badge and receives messages live", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupChatData();
  const alpha = setupHousehold(3, "Gamma")!;
  const beta = setupHousehold(4, "Delta")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await signInWithTestAuth(pageA, alpha.email);
    await signInWithTestAuth(pageB, beta.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });

    // Beta opens the everyone thread and waits for realtime delivery
    await openChatTab(pageB);
    await openThreadByTitle(pageB, "Everyone");

    // Alpha sends from a separate session
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await pageA.getByTestId("chat-composer-input").fill("Live over realtime");
    await pageA.getByTestId("chat-send-button").click();

    // Beta sees the message arrive without a reload (Supabase Realtime)
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Live over realtime" }).first()).toBeVisible({ timeout: 20_000 });

    // Beta goes back; the inbox unread badge reflects the message they read
    await pageB.getByTestId("chat-thread-back").click();
    await expect(pageB.getByTestId("chat-inbox-screen")).toBeVisible();
    const betaUnread = await pageB.getByTestId("chat-unread-badge").count();
    assert.ok(betaUnread === 0, `Beta read the thread, so unread badge should be gone (found ${betaUnread})`);

    // Alpha's own session shows no unread for their own sent message
    await pageA.getByTestId("chat-thread-back").click();
    const alphaUnread = await pageA.getByTestId("chat-unread-badge").count();
    assert.ok(alphaUnread === 0, `Sending a message should not create unread for the sender (found ${alphaUnread})`);
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupChatData();
  }
});

test("Chat: parent detail Message button opens the DM thread", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(5, "Epsilon")!;
  const beta = setupHousehold(6, "Zeta")!;
  assert.ok(alpha && beta);

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });

    // Home → Directory → parent detail
    await page.getByTestId("directory-link").click();
    await expect(page.getByTestId("directory-screen")).toBeVisible();
    await page.getByTestId(`directory-parent-${beta.userId}`).click();
    await expect(page.getByTestId("parent-detail-screen")).toBeVisible();

    // Message button opens (creates) the DM
    await page.getByTestId("parent-detail-message").click();
    await expect(page.getByTestId("chat-thread-screen")).toBeVisible();
    await expect(page.locator(".chat-thread-header-info h1")).toContainText("Zeta");

    // Send + verify the bubble
    await page.getByTestId("chat-composer-input").fill("Direct message");
    await page.getByTestId("chat-send-button").click();
    await expect(page.locator(".chat-bubble-body", { hasText: "Direct message" }).first()).toBeVisible();

    // Re-opening from the inbox finds the same thread (idempotent DM)
    await page.getByTestId("chat-thread-back").click();
    await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
    await page.locator(".chat-thread-row", { hasText: "Zeta" }).first().click();
    await expect(page.locator(".chat-bubble-body", { hasText: "Direct message" }).first()).toBeVisible();
  } finally {
    cleanupChatData();
  }
});

test("Chat: new-chat sheet creates a group thread with selected parents", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(7, "Eta")!;
  const beta = setupHousehold(8, "Theta")!;
  const gamma = setupHousehold(9, "Iota")!;
  assert.ok(alpha && beta && gamma);

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(page);

    await page.getByTestId("chat-new-button").click();
    await expect(page.getByTestId("chat-new-chat")).toBeVisible();

    // Two selections promote the sheet to group mode with a title input
    await page.getByTestId(`chat-new-chat-member-${beta.userId}`).click();
    await page.getByTestId(`chat-new-chat-member-${gamma.userId}`).click();
    await page.getByTestId("chat-new-chat-title").fill("Van crew");
    await page.getByTestId("chat-new-chat-start").click();

    await expect(page.getByTestId("chat-thread-screen")).toBeVisible();
    await expect(page.locator(".chat-thread-header-info h1")).toContainText("Van crew");
    await expect(page.locator(".chat-thread-header-info small")).toContainText("Theta");

    // The group thread also appears in the inbox
    await page.getByTestId("chat-thread-back").click();
    await expect(page.locator(".chat-thread-row", { hasText: "Van crew" })).toBeVisible();
  } finally {
    cleanupChatData();
  }
});

test("Chat: proposal card renders, confirm is gated, and decline posts a note", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(10, "Kappa")!;
  const beta = setupHousehold(11, "Lambda")!;
  assert.ok(alpha && beta);

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(page);
    await openThreadByTitle(page, "Everyone");

    // Simulate the M2 Crew AI agent: service-role insert of a pending
    // cancel_ride proposal + linked agent message.
    const threadId = runSql(`
      SELECT id FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'everyone' LIMIT 1;
    `).rows![0]!.id as string;
    runSql(`
      INSERT INTO public.chat_proposals (id, group_id, thread_id, kind, params, summary, required_confirmer_profile_id, status)
      VALUES ('${UID(800)}', '${GROUP_ID}', '${threadId}', 'cancel_ride', '{}'::jsonb,
              'Cancel Mia Chatty Tuesday morning ride', '${beta.userId}', 'pending');
      INSERT INTO public.chat_messages (thread_id, sender_kind, sender_name, body, proposal_id)
      VALUES ('${threadId}', 'agent', 'Crew AI', 'I can cancel Mia Chatty Tuesday morning ride. Tap confirm and I will make it happen.', '${UID(800)}');
    `);

    // The card renders for alpha but alpha is not the required confirmer
    await expect(page.getByTestId("chat-proposal-card")).toBeVisible({ timeout: 15_000 });
    assert.equal(await page.getByTestId("chat-proposal-confirm").count(), 0, "Confirm button must not render for non-confirmers");

    // Beta (the required confirmer) sees and declines it
    await signInWithTestAuth(page, beta.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(page);
    await openThreadByTitle(page, "Everyone");
    await expect(page.getByTestId("chat-proposal-card")).toBeVisible();
    await page.getByTestId("chat-proposal-decline").click();
    await expect(page.locator(".chat-proposal-status--declined")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".chat-bubble-body", { hasText: "off the table" }).first()).toBeVisible();
  } finally {
    cleanupChatData();
  }
});

test("Chat: unread badge shows on sign-in without opening the Chat tab", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(12, "Mu")!;
  const beta = setupHousehold(13, "Nu")!;
  assert.ok(alpha && beta);

  // Alpha ensures the everyone thread exists (enrolling both) and sends
  // two messages Beta has never read.
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  try {
    await signInWithTestAuth(pageA, alpha.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await pageA.getByTestId("chat-composer-input").fill("Badge one");
    await pageA.getByTestId("chat-send-button").click();
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Badge one" }).first()).toBeVisible();
    await pageA.getByTestId("chat-composer-input").fill("Badge two");
    await pageA.getByTestId("chat-send-button").click();
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Badge two" }).first()).toBeVisible();
  } finally {
    await contextA.close();
  }

  // Beta signs in fresh and lands on Home — the Chat tab badge must already
  // show 2 without the tab ever being opened (counted at identity load).
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await signInWithTestAuth(pageB, beta.email);
    await expect(pageB.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });
    const badge = pageB.getByTestId("nav-chat").locator(".nav-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("2");

    // Opening Chat shows the per-thread unread; reading the thread clears
    // the badge entirely. A real reader sees the messages before leaving:
    // assert the bubbles rendered (and the app-level refresh that follows
    // markRead) BEFORE backing out — otherwise the test races the thread
    // screen's async initial load and the unread state is legitimately kept.
    await openChatTab(pageB);
    const everyoneRow = pageB.locator(".chat-thread-row", { hasText: "Everyone" }).first();
    await expect(everyoneRow.getByTestId("chat-unread-badge")).toHaveText("2");
    await everyoneRow.click();
    await expect(pageB.getByTestId("chat-thread-screen")).toBeVisible();
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Badge one" }).first()).toBeVisible();
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Badge two" }).first()).toBeVisible();
    await expect(pageB.getByTestId("nav-chat").locator(".nav-badge")).toHaveCount(0, { timeout: 10_000 });
    await pageB.getByTestId("chat-thread-back").click();
    await expect(pageB.getByTestId("nav-chat").locator(".nav-badge")).toHaveCount(0);
  } finally {
    await contextB.close();
    cleanupChatData();
  }
});

test("Chat: badge updates live while sitting on another tab", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(14, "Xi")!;
  const beta = setupHousehold(15, "Omicron")!;
  assert.ok(alpha && beta);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    // Alpha ensures the everyone thread and waits inside it.
    await signInWithTestAuth(pageA, alpha.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");

    // Beta signs in and stays on Home — no badge yet (nothing unread).
    await signInWithTestAuth(pageB, beta.email);
    await expect(pageB.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });
    await expect(pageB.getByTestId("nav-chat").locator(".nav-badge")).toHaveCount(0);

    // Alpha sends; Beta's badge lights up on Home without any navigation.
    await pageA.getByTestId("chat-composer-input").fill("Live badge");
    await pageA.getByTestId("chat-send-button").click();
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Live badge" }).first()).toBeVisible();

    const badge = pageB.getByTestId("nav-chat").locator(".nav-badge");
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveText("1");
  } finally {
    await contextA.close();
    await contextB.close();
    cleanupChatData();
  }
});
test("Chat: bell toggle visibly mutes and unmutes a thread", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(16, "Sigma")!;
  assert.ok(alpha);

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(page);
    await openThreadByTitle(page, "Everyone");

    const bell = page.getByTestId("chat-mute-button");
    await expect(page.locator(".chat-muted-flag")).toHaveCount(0);

    // Mute: the slash wrapper renders (HTML span, not SVG), the pinned
    // "Muted" flag appears in the subtitle, and the aria-label flips.
    await bell.click();
    await expect(page.locator(".chat-muted-flag")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".chat-muted-flag")).toHaveText("Muted");
    assert.equal(await page.locator(".chat-mute-icon--muted").count(), 1, "Muted slash wrapper must render");
    assert.equal(await bell.getAttribute("aria-label"), "Unmute notifications");

    // Unmute: every visible trace clears.
    await bell.click();
    await expect(page.locator(".chat-muted-flag")).toHaveCount(0, { timeout: 15_000 });
    assert.equal(await page.locator(".chat-mute-icon--muted").count(), 0);
    assert.equal(await bell.getAttribute("aria-label"), "Mute notifications");
  } finally {
    cleanupChatData();
  }
});

test("Chat: push deep link opens the thread directly from a fresh load", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(17, "Tau")!;
  const beta = setupHousehold(18, "Upsilon")!;
  assert.ok(alpha && beta);

  // Alpha ensures the everyone thread exists and leaves a message.
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  try {
    await signInWithTestAuth(pageA, alpha.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await pageA.getByTestId("chat-composer-input").fill("Deep link check");
    await pageA.getByTestId("chat-send-button").click();
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Deep link check" }).first()).toBeVisible();
  } finally {
    await contextA.close();
  }

  const threadId = (runSql(`
    SELECT id FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'everyone' LIMIT 1;
  `).rows ?? [])[0] as { id: string };

  // When a real parent taps a push notification, the OS opens the app at
  // the payload URL. Simulate exactly that: a FRESH load carrying both the
  // testAuth sign-in and the #thread hash — the thread must open directly,
  // and the deep-linked open counts as reading it.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  try {
    await pageB.goto(`/?testAuth=${beta.email}|${TEST_PASSWORD}#thread=${threadId.id}`);
    await expect(pageB.getByTestId("chat-thread-screen")).toBeVisible({ timeout: 20_000 });
    await expect(pageB.locator(".chat-thread-header-info h1")).toContainText("Everyone");
    await expect(pageB.locator(".chat-bubble-body", { hasText: "Deep link check" }).first()).toBeVisible();

    // No unread remains for the deep-linked thread anywhere.
    await pageB.getByTestId("chat-thread-back").click();
    await expect(pageB.getByTestId("chat-inbox-screen")).toBeVisible();
    await expect(pageB.getByTestId("nav-chat").locator(".nav-badge")).toHaveCount(0);
  } finally {
    await contextB.close();
    cleanupChatData();
  }
});

test("Chat: notification tap while the app is running opens the thread (service worker handoff)", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupChatData();
  const alpha = setupHousehold(19, "Phi")!;
  const beta = setupHousehold(20, "Chi")!;
  assert.ok(alpha && beta);

  // Alpha ensures the everyone thread exists and leaves a message.
  const contextA = await page.context().browser()?.newContext();
  const pageA = await contextA!.newPage();
  try {
    await signInWithTestAuth(pageA, alpha.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await openChatTab(pageA);
    await openThreadByTitle(pageA, "Everyone");
    await pageA.getByTestId("chat-composer-input").fill("Handoff check");
    await pageA.getByTestId("chat-send-button").click();
    await expect(pageA.locator(".chat-bubble-body", { hasText: "Handoff check" }).first()).toBeVisible();
  } finally {
    await contextA?.close();
  }

  const threadId = (runSql(`
    SELECT id FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'everyone' LIMIT 1;
  `).rows ?? [])[0] as { id: string };

  // Beta is signed in and sitting on HOME — the app is running, exactly the
  // suspended-in-background case the iOS handoff exists for. sw.js focuses
  // the app and postMessages { type: "chat-open-thread", threadId }; the
  // app opens the thread from any screen. Simulate the postMessage with a
  // synthetic MessageEvent on navigator.serviceWorker (the app's listener
  // is what this proves; the SW side is contract-tested above).
  await signInWithTestAuth(page, beta.email);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });
  await page.evaluate((id) => {
    navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: { type: "chat-open-thread", threadId: id } }),
    );
  }, threadId.id);

  await expect(page.getByTestId("chat-thread-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".chat-thread-header-info h1")).toContainText("Everyone");
  await expect(page.locator(".chat-bubble-body", { hasText: "Handoff check" }).first()).toBeVisible();

  // The handoff open counts as reading: no unread badge remains.
  await page.getByTestId("chat-thread-back").click();
  await expect(page.getByTestId("nav-chat").locator(".nav-badge")).toHaveCount(0);
});
