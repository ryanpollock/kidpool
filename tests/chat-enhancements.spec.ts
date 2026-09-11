import { test, expect, type Page } from "@playwright/test";
import { chatFixture } from "./lib/chat-fixture.ts";
import { TEST_PASSWORD } from "./lib/playwright-helpers.ts";

test("Chat enhancements: two parents react, tag, set mentions-only and open links", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const f = await chatFixture();
  const ca = await browser.newContext(),
    cb = await browser.newContext();
  // Metadata fetching has its own real-service integration test. Keep this
  // rendering test deterministic: an in-flight fetch must not overwrite the
  // fixture card after it is inserted below.
  for (const context of [ca, cb]) {
    await context.route("**/functions/v1/chat-link-preview", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ status: "pending" }),
    }));
  }
  const a = await ca.newPage(),
    b = await cb.newPage();
  const login = async (page: Page, email: string) => {
    await page.goto(
      `/?testAuth=${encodeURIComponent(email + "|" + TEST_PASSWORD)}`,
    );
    await expect(page.getByTestId("nav-chat")).toBeVisible({ timeout: 25_000 });
    await page.getByTestId("nav-chat").click();
    await expect(page.getByTestId("chat-thread-row").first()).toBeVisible();
  };
  try {
    await login(a, f.people[0].email);
    await login(b, f.people[1].email);
    await a
      .getByTestId("chat-thread-row")
      .filter({ hasText: f.people[1].name })
      .click();
    await b
      .getByTestId("chat-thread-row")
      .filter({ hasText: f.people[0].name })
      .click();
    const input = a.getByTestId("chat-composer-input");
    await input.fill("Meet at the playground");
    await a.getByTestId("chat-send-button").click();
    const received = b
      .locator(".chat-message-enhancements")
      .filter({ hasText: "Meet at the playground" });
    await expect(received).toBeVisible({ timeout: 15_000 });
    // Radix disables background pointer events, so Playwright can click a
    // visually covered sheet. Enable the background just for hit testing to
    // verify that the picker actually paints above the conversation.
    await received.getByRole("button", { name: "React to message" }).click();
    const thumbsUp = b.getByRole("button", { name: "React 👍", exact: true });
    await expect(thumbsUp).toBeVisible();
    await expect.poll(() => thumbsUp.evaluate((button) => {
      const layer = document.querySelector<HTMLElement>(".chat-thread-layer")!;
      const previous = layer.style.pointerEvents;
      layer.style.pointerEvents = "auto";
      try {
        const rect = button.getBoundingClientRect();
        const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return top === button || button.contains(top);
      } finally {
        layer.style.pointerEvents = previous;
      }
    })).toBe(true);
    await b.screenshot({ path: test.info().outputPath("chat-reaction-picker.png") });
    await b.keyboard.press("Escape");
    await expect(b.getByTestId("bottom-sheet")).toHaveCount(0);
    const box = await received.locator(".chat-bubble-body").boundingBox();
    if (!box) throw new Error("Message geometry missing");
    await b.mouse.move(box.x + 10, box.y + 10);
    await b.mouse.down();
    await b.waitForTimeout(600);
    await b.mouse.up();
    await b.getByRole("button", { name: "React 👍", exact: true }).click();
    await expect(
      a.getByRole("button", { name: "👍 1 reactions; view people" }),
    ).toBeVisible({ timeout: 15_000 });
    await received.getByRole("button", { name: "React to message" }).click();
    await b.getByRole("button", { name: "React 😂", exact: true }).click();
    await expect(
      a.getByRole("button", { name: "😂 1 reactions; view people" }),
    ).toBeVisible();
    await b.reload();
    await expect(b.getByTestId("nav-chat")).toBeVisible();
    await b.getByTestId("nav-chat").click();
    await b
      .getByTestId("chat-thread-row")
      .filter({ hasText: f.people[0].name })
      .click();
    await expect(
      b.getByRole("button", { name: "😂 1 reactions; view people" }),
    ).toBeVisible();
    await input.fill("Hi @Bla");
    await a.getByRole("option", { name: f.people[1].name }).click();
    await expect(input).toHaveValue(`Hi @${f.people[1].name} `);
    await input.press("Enter");
    await expect(b.locator(".chat-mention")).toHaveText(`@${f.people[1].name}`);
    const message = f.must(
      await f.admin
        .from("chat_messages")
        .select("mentions")
        .eq("thread_id", f.dm)
        .like("body", "Hi @%")
        .single(),
    );
    expect(message.mentions[0].profile_id).toBe(f.people[1].id);
    await input.fill("Read https://example.com/");
    await a.getByTestId("chat-send-button").click();
    await expect(b.locator(".chat-bubble-body a")).toHaveAttribute(
      "href",
      "https://example.com/",
    );
    await b.screenshot({
      path: test.info().outputPath("chat-links-and-reactions.png"),
    });
    // Seed deterministic metadata to test realtime card rendering without an external website dependency.
    const link = f.must(
      await f.admin
        .from("chat_messages")
        .select("id")
        .eq("thread_id", f.dm)
        .eq("body", "Read https://example.com/")
        .single(),
    );
    f.must(
      await f.admin.from("chat_link_previews").upsert({
        message_id: link.id,
        thread_id: f.dm,
        url: "https://example.com/",
        status: "ready",
        title: "Example preview",
        description: "Preview description",
      }),
    );
    await expect(b.getByTestId("chat-link-preview")).toContainText(
      "Example preview",
    );
    await b.screenshot({
      path: test.info().outputPath("chat-preview-card.png"),
    });
    await b.getByTestId("chat-thread-back").click();
    await b
      .getByTestId("chat-thread-row")
      .filter({ hasText: "Everyone" })
      .click();
    await b.getByRole("button", { name: "Notification settings" }).click();
    await b.getByRole("button", { name: "Mentions only", exact: true }).click();
    await expect(b.locator(".chat-muted-flag")).toHaveText("Mentions only");
    await b.reload();
    await expect(b.getByTestId("nav-chat")).toBeVisible();
    await b.getByTestId("nav-chat").click();
    await b
      .getByTestId("chat-thread-row")
      .filter({ hasText: "Everyone" })
      .click();
    await expect(b.locator(".chat-muted-flag")).toHaveText("Mentions only");
    await b.getByRole("button", { name: "Notification settings" }).click();
    await b.getByRole("button", { name: "Muted", exact: true }).click();
    await expect(b.locator(".chat-muted-flag")).toHaveText("Muted");
  } finally {
    await ca.close();
    await cb.close();
    await f.cleanup();
  }
});
