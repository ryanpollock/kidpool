// E2E tests for Crewmate AI Phase 1: the pinned Crewmate entry in the
// new-conversation sheet, the private agent thread (kind='agent') with
// its disclosure note, the pinned inbox row, and composer sending.
// The LLM loop itself is covered by the eval harness
// (npm run eval:crewmate / eval:crewmate:e2e), not by E2E.
//
// Run locally:   npm run test:runtime:local -- --grep "Crewmate"
// Run on staging: npm run test:runtime -- --grep "Crewmate" (after the
//                 migration + function deploy land on staging)

import { expect, test } from "@playwright/test";
import {
  getSpecEnv, makeRunSql, makeAuth, truncateAll,
  UID, PILOT_GROUP_ID, signInWithTestAuth,
} from "./lib/playwright-helpers.ts";

const env = getSpecEnv();
const runSql = makeRunSql(env);
const { createTestUser, deleteAllTestUsers } = makeAuth(env);
const skip = !env.serviceKey;

const GROUP_ID = PILOT_GROUP_ID;

function setupHousehold(n: number, name: string): { userId: string; email: string } | null {
  const email = `crew-${name.toLowerCase()}@test.kidpool`;
  const userId = createTestUser(email);
  if (!userId) return null;
  const householdId = UID(740 + n);
  runSql(`
    INSERT INTO public.profiles (id, email, full_name) VALUES ('${userId}', '${email}', '${name} Crewmate') ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
    INSERT INTO public.households (id, group_id, name, created_by) VALUES ('${householdId}', '${GROUP_ID}', '${name} CrewHousehold', '${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.memberships (group_id, household_id, profile_id, role, status) VALUES ('${GROUP_ID}', '${householdId}', '${userId}', 'member', 'active') ON CONFLICT DO NOTHING;
  `);
  return { userId, email };
}

function cleanupCrewmateData(): void {
  if (env.isLocal) {
    truncateAll(runSql, GROUP_ID);
  } else {
    runSql(`
      DELETE FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'agent';
      DELETE FROM public.chat_threads WHERE group_id = '${GROUP_ID}' AND kind = 'dm';
      DELETE FROM public.households WHERE group_id = '${GROUP_ID}' AND id::text LIKE 'deadbeef-%';
      DELETE FROM public.profiles WHERE email LIKE 'crew-%@test.kidpool';
    `);
  }
  deleteAllTestUsers();
}

test("Crewmate: pinned entry opens a private Crewmate thread with disclosure", async ({ page }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(90_000);

  cleanupCrewmateData();
  const alpha = setupHousehold(21, "Alpha")!;
  const beta = setupHousehold(22, "Beta")!;

  try {
    await signInWithTestAuth(page, alpha.email);
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("nav-chat").click();
    await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
    await expect(page.getByTestId("chat-thread-row").first()).toBeVisible({ timeout: 15_000 });

    // Open the new-conversation sheet; the pinned Crewmate entry is always
    // present, even while the directory is still loading.
    await page.getByTestId("chat-new-button").click();
    const crewmateEntry = page.getByTestId("chat-new-chat-crewmate");
    await expect(crewmateEntry).toBeVisible({ timeout: 10_000 });
    await expect(crewmateEntry).toContainText("Crewmate AI");

    await crewmateEntry.click();
    await expect(page.getByTestId("chat-thread-screen")).toBeVisible({ timeout: 15_000 });

    // The thread is titled Crewmate AI and opens with the disclosure note.
    await expect(page.locator(".chat-thread-header h1")).toHaveText("Crewmate AI");
    await expect(page.getByTestId("chat-system-note").first()).toContainText("Crewmate AI");
    await expect(page.getByTestId("chat-system-note").first()).toContainText("nothing changes unless a parent confirms");

    // The parent can send a message in the private thread.
    await page.getByTestId("chat-composer-input").fill("Who is driving Wednesday morning?");
    await page.getByTestId("chat-send-button").click();
    await expect(page.locator(".chat-bubble-body", { hasText: "Who is driving Wednesday morning?" }).first()).toBeVisible();

    // Back in the inbox, the Crewmate thread is pinned above Everyone.
    await page.getByTestId("chat-thread-back").click();
    await expect(page.getByTestId("chat-inbox-screen")).toBeVisible();
    const firstRow = page.locator(".chat-thread-row").first();
    await expect(firstRow).toContainText("Crewmate AI");
    await expect(page.locator(".chat-thread-row", { hasText: "Everyone" }).first()).toBeVisible();
  } finally {
    cleanupCrewmateData();
  }
});

test("Crewmate: the private thread is invisible to other parents in the inbox", async ({ browser }) => {
  test.skip(skip, "No service key available");
  test.setTimeout(120_000);

  cleanupCrewmateData();
  const alpha = setupHousehold(23, "Alpha")!;
  const beta = setupHousehold(24, "Beta")!;

  try {
    // Alpha creates their private Crewmate thread.
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signInWithTestAuth(pageA, alpha.email);
    await expect(pageA.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await pageA.getByTestId("nav-chat").click();
    await expect(pageA.getByTestId("chat-inbox-screen")).toBeVisible();
    await pageA.getByTestId("chat-new-button").click();
    await pageA.getByTestId("chat-new-chat-crewmate").click();
    await expect(pageA.getByTestId("chat-thread-screen")).toBeVisible({ timeout: 15_000 });
    await pageA.getByTestId("chat-thread-back").click();

    // Beta's inbox shows the pinned Crewmate ENTRY (a button in the sheet)
    // but never Alpha's private thread row.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signInWithTestAuth(pageB, beta.email);
    await expect(pageB.getByTestId("nav-chat")).toBeVisible({ timeout: 20_000 });
    await pageB.getByTestId("nav-chat").click();
    await expect(pageB.getByTestId("chat-inbox-screen")).toBeVisible();
    await expect(pageB.getByTestId("chat-thread-row").first()).toBeVisible({ timeout: 15_000 });
    // Match on the row TITLE only — the Everyone row's preview also mentions
    // Crewmate AI in its disclosure text.
    await expect(pageB.locator(".chat-thread-name", { hasText: "Crewmate AI" })).toHaveCount(0);

    await contextA.close();
    await contextB.close();
  } finally {
    cleanupCrewmateData();
  }
});