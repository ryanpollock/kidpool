import { expect, test, type Locator, type Page } from "@playwright/test";

async function drag(page: Page, locator: Locator, deltaX: number, deltaY: number, steps = 8) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Drag target has no bounding box");
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(
      startX + (deltaX * step) / steps,
      startY + (deltaY * step) / steps,
    );
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/runtime-fixture.html");
});

test("horizontal intent stays in Carousel and cannot create parent momentum", async ({ page }) => {
  const carousel = page.locator(".fixture-carousel");
  const card = page.locator(".carousel-card").nth(1);
  const parent = page.getByTestId("mobile-scroll");

  await expect(carousel).not.toHaveAttribute("data-scroll-drag", "ignore");
  await drag(page, card, -130, 14, 5);

  const afterRelease = await carousel.evaluate((element) => element.scrollLeft);
  expect(afterRelease).toBeGreaterThan(40);
  expect(await parent.evaluate((element) => element.scrollTop)).toBe(0);

  await page.waitForTimeout(250);
  expect(await parent.evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.getByTestId("tap-count").textContent()).toBe("0");
});

test("vertical intent over a carousel is handed to MobileScroll in both directions", async ({ page }) => {
  const card = page.locator(".carousel-card").nth(1);
  const carousel = page.locator(".fixture-carousel");
  const parent = page.getByTestId("mobile-scroll");

  await drag(page, card, 4, -150);
  expect(await parent.evaluate((element) => element.scrollTop)).toBeGreaterThan(60);
  expect(await carousel.evaluate((element) => element.scrollLeft)).toBe(0);

  await parent.evaluate((element) => {
    element.scrollTop = 80;
  });
  await drag(page, card, -3, 110);
  expect(await parent.evaluate((element) => element.scrollTop)).toBeLessThan(80);
});

test("tap activates a card but a completed drag does not", async ({ page }) => {
  const firstCard = page.locator(".carousel-card").first();
  await firstCard.click();
  await expect(page.getByTestId("tap-count")).toHaveText("1");

  await drag(page, firstCard, -100, 6);
  await expect(page.getByTestId("tap-count")).toHaveText("1");
});

test("Carousel preserves momentum and edge rubber-banding", async ({ page }) => {
  const carousel = page.locator(".fixture-carousel");
  const card = page.locator(".carousel-card").nth(1);

  await drag(page, card, -100, 5, 3);
  const releasedOffset = await carousel.evaluate((element) => element.scrollLeft);
  await page.waitForTimeout(120);
  expect(await carousel.evaluate((element) => element.scrollLeft)).toBeGreaterThan(releasedOffset);

  await carousel.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const box = await card.boundingBox();
  if (!box) throw new Error("Card has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 4 });
  expect(Number(await carousel.getAttribute("data-overscroll"))).toBeGreaterThan(0);
  await page.mouse.up();
  await page.waitForTimeout(900);
  expect(Math.abs(Number(await carousel.getAttribute("data-overscroll")))).toBeLessThan(1);
});

test("BottomSheet remains mounted while its default exit animation plays", async ({ page }) => {
  await page.locator(".sheet-trigger").click();
  await expect(page.getByTestId("bottom-sheet")).toBeVisible();

  await page.getByTestId("sheet-overlay").click({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId("bottom-sheet")).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
});

test("keyboard and its attached footer dismiss on the same transition", async ({ page }) => {
  await page.goto("/tests/runtime-fixture.html?fixture=keyboard");
  const input = page.getByLabel("Message");
  const footer = page.getByTestId("flow-fixed-footer");
  const keyboard = page.getByTestId("keyboard-dock");

  await input.click();
  await expect(keyboard).toHaveAttribute("data-visible", "true");
  await drag(page, footer, 0, 120, 5);
  await expect(keyboard).toHaveAttribute("data-visible", "false");

  await page.waitForTimeout(100);
  const progress = await page.evaluate(() => {
    const footerElement = document.querySelector<HTMLElement>('[data-testid="flow-fixed-footer"]')!;
    const keyboardElement = document.querySelector<HTMLElement>('[data-testid="keyboard-dock"]')!;
    const fullHeight = Number.parseFloat(keyboardElement.style.height);
    const footerRemaining = Number.parseFloat(getComputedStyle(footerElement).bottom);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(keyboardElement).transform);
    return {
      footer: footerRemaining / fullHeight,
      keyboard: 1 - matrix.m42 / fullHeight,
    };
  });
  expect(Math.abs(progress.footer - progress.keyboard)).toBeLessThan(0.18);

  await page.waitForTimeout(300);
  expect(await footer.evaluate((element) => getComputedStyle(element).bottom)).toBe("34px");
});

test("switching to Pixel keeps the composer above Android navigation", async ({ page }) => {
  await page.goto("/tests/runtime-fixture.html?fixture=keyboard");
  const input = page.getByLabel("Message");
  await input.evaluate((element: HTMLInputElement) => {
    element.value = "Draft message";
  });

  await page.getByTestId("device-picker").click();
  await page.getByTestId("device-option-pixel-10").click();

  const frame = page.getByTestId("phone-frame");
  const screen = page.getByTestId("device-screen");
  const statusIndicators = page.getByTestId("status-indicators");
  const navigation = page.getByTestId("android-navigation-bar");
  const footer = page.getByTestId("flow-fixed-footer");

  await expect(frame).toHaveAttribute("data-device", "pixel-10");
  await expect(screen).toHaveAttribute("data-device", "pixel-10");
  await expect(page.locator(".phone-bezel")).toHaveAttribute(
    "src",
    "/assets/android/Pixel10.png",
  );
  await expect(statusIndicators).toHaveAttribute("data-platform", "android");
  await expect(statusIndicators).toHaveAttribute(
    "src",
    "/assets/status/status-icons.svg",
  );
  await expect(navigation).toBeVisible();
  await expect(page.getByTestId("home-indicator")).toHaveCount(0);
  await expect(input).toHaveValue("Draft message");
  await page.waitForTimeout(300);

  const layout = await page.evaluate(() => {
    const footerElement = document.querySelector<HTMLElement>(
      '[data-testid="flow-fixed-footer"]',
    )!;
    const navigationElement = document.querySelector<HTMLElement>(
      '[data-testid="android-navigation-bar"]',
    )!;
    const appViewportElement = document.querySelector<HTMLElement>(
      '[data-testid="mobile-app-viewport"]',
    )!;
    return {
      footerBottom: footerElement.getBoundingClientRect().bottom,
      appViewportBottom: appViewportElement.getBoundingClientRect().bottom,
      navigationTop: navigationElement.getBoundingClientRect().top,
      navigationHeight: Number.parseFloat(getComputedStyle(navigationElement).height),
      safeAreaBottom: Number.parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>('[data-testid="device-screen"]')!).getPropertyValue(
          "--device-safe-area-bottom",
        ),
      ),
    };
  });

  expect(layout.safeAreaBottom).toBe(layout.navigationHeight);
  expect(Math.abs(layout.appViewportBottom - layout.navigationTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.footerBottom - layout.navigationTop)).toBeLessThanOrEqual(1);

  await input.click();
  await expect(page.getByTestId("keyboard-dock")).toHaveAttribute("data-visible", "true");
  await expect(navigation).toHaveCount(0);
  await page.waitForTimeout(300);

  const keyboardLayout = await page.evaluate(() => {
    const screen = document.querySelector<HTMLElement>('[data-testid="device-screen"]')!;
    const viewport = document.querySelector<HTMLElement>('[data-testid="mobile-app-viewport"]')!;
    const scroll = document.querySelector<HTMLElement>('[data-testid="mobile-scroll"]')!;
    const footerElement = document.querySelector<HTMLElement>('[data-testid="flow-fixed-footer"]')!;
    const keyboard = document.querySelector<HTMLElement>('[data-testid="keyboard-dock"]')!;

    return {
      screenBottom: screen.getBoundingClientRect().bottom,
      viewportBottom: viewport.getBoundingClientRect().bottom,
      scrollBottom: scroll.getBoundingClientRect().bottom,
      footerBottom: footerElement.getBoundingClientRect().bottom,
      keyboardTop: keyboard.getBoundingClientRect().top,
      keyboardBottom: keyboard.getBoundingClientRect().bottom,
    };
  });

  expect(keyboardLayout.viewportBottom).toBeCloseTo(keyboardLayout.screenBottom, 0);
  expect(Math.abs(keyboardLayout.keyboardBottom - keyboardLayout.screenBottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(keyboardLayout.scrollBottom - keyboardLayout.keyboardTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(keyboardLayout.footerBottom - keyboardLayout.keyboardTop)).toBeLessThanOrEqual(1);
});

test("FlowStack pushes and pops screens while dismissing the keyboard", async ({ page }) => {
  await page.goto("/tests/runtime-fixture.html?fixture=flow");
  await page.getByLabel("Flow message").click();
  await expect(page.getByTestId("keyboard-dock")).toHaveAttribute("data-visible", "true");

  await page.getByRole("button", { name: "Push level 2" }).click();
  await expect(page.getByRole("heading", { name: "Screen stacking works" })).toBeVisible();
  await expect(page.getByTestId("keyboard-dock")).toHaveAttribute("data-visible", "false");
  const safeHeaderPlacement = await page.evaluate(() => {
    const screen = document.querySelector<HTMLElement>('[data-testid="device-screen"]')!;
    const toolbar = document.querySelector<HTMLElement>(".flow-fixture-header")!;
    return toolbar.getBoundingClientRect().top - screen.getBoundingClientRect().top;
  });
  expect(safeHeaderPlacement).toBeGreaterThanOrEqual(54);

  await page.getByRole("button", { name: "Push level 3" }).click();
  await expect(page.getByRole("heading", { name: "Nested view level 3" })).toBeVisible();
  await page.getByRole("button", { name: "Push level 4" }).click();
  await expect(page.getByRole("heading", { name: "Nested view level 4" })).toBeVisible();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Nested view level 3" })).toBeVisible();
  await page.getByRole("button", { name: "‹ Back" }).click();
  await expect(page.getByRole("heading", { name: "Screen stacking works" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "Flow root" })).toBeVisible();
});

// ── Frameless production runtime ──────────────────────────────────
// Device geometry is all zeros in the frameless runtime, so these tests pin
// the behavior that broke in production: BottomSheet must size itself from
// the measured portal (the real viewport), expand on an upward handle drag,
// collapse on a downward drag from the top snap, and dismiss on a downward
// drag from the default snap.

test.describe("BottomSheet in the frameless production runtime", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/tests/runtime-fixture-frameless.html");
  });

  async function sheetHeight(page: import("@playwright/test").Page) {
    const box = await page.getByTestId("bottom-sheet").boundingBox();
    if (!box) throw new Error("Sheet has no bounding box");
    return box.height;
  }

  test("sizes from the real viewport, not the zeroed device geometry", async ({ page }) => {
    await page.locator(".sheet-trigger").click();
    await expect(page.getByTestId("bottom-sheet")).toBeVisible();
    await page.waitForTimeout(650);

    // 0.72 × 844 ≈ 608 — the 260px floor (what device geometry produces)
    // would be less than half this.
    const height = await sheetHeight(page);
    expect(Math.abs(height - 0.72 * 844)).toBeLessThanOrEqual(24);
    expect(height).toBeGreaterThan(400);

    // Tall content is scrollable within the capped sheet.
    const overflow = await page.getByTestId("frameless-sheet-content").evaluate(
      (element) => {
        const scroller = element.closest<HTMLElement>(".sheet-content")!;
        return {
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
        };
      },
    );
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);
  });

  test("handle drag expands to the top snap, collapses, then dismisses", async ({ page }) => {
    await page.locator(".sheet-trigger").click();
    await expect(page.getByTestId("bottom-sheet")).toBeVisible();
    await page.waitForTimeout(650);
    const collapsed = await sheetHeight(page);
    expect(Math.abs(collapsed - 0.72 * 844)).toBeLessThanOrEqual(24);

    // Drag up on the handle → expanded to ~0.94 of the viewport.
    await drag(page, page.getByTestId("sheet-handle"), 0, -80);
    await page.waitForTimeout(650);
    const expandedHeight = await sheetHeight(page);
    expect(Math.abs(expandedHeight - 0.94 * 844)).toBeLessThanOrEqual(24);

    // Drag down from the top snap → collapses back to the default snap.
    await drag(page, page.getByTestId("sheet-handle"), 0, 120);
    await page.waitForTimeout(650);
    const collapsedAgain = await sheetHeight(page);
    expect(Math.abs(collapsedAgain - 0.72 * 844)).toBeLessThanOrEqual(24);

    // Drag down from the default snap → dismisses.
    await drag(page, page.getByTestId("sheet-handle"), 0, 160);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
  });

  test("native keyboard overlap raises the sheet above the fold and restores on dismiss", async ({ page }) => {
    await page.locator(".sheet-trigger").click();
    await expect(page.getByTestId("bottom-sheet")).toBeVisible();
    await page.waitForTimeout(650);

    // Emulate the iOS keyboard: the visual viewport shrinks while the layout
    // viewport (window.innerHeight) stays put — the production scenario the
    // simulated KeyboardDock can't represent.
    const emulateKeyboard = (covered: number) =>
      page.evaluate((span) => {
        const viewport = window.visualViewport;
        Object.defineProperty(viewport, "height", {
          configurable: true,
          get: () => window.innerHeight - span,
        });
        viewport.dispatchEvent(new Event("resize"));
      }, covered);

    await emulateKeyboard(340);
    await page.waitForTimeout(300);

    const sheet = await page.getByTestId("bottom-sheet").boundingBox();
    if (!sheet) throw new Error("Sheet has no bounding box");
    // Bottom edge sits above the keyboard's top edge.
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(844 - 340 + 24);
    // The sheet shrinks but stays a usable height above the floor.
    expect(sheet.height).toBeGreaterThanOrEqual(240);
    expect(Math.abs(sheet.height - (0.72 * 844 - 340))).toBeLessThanOrEqual(24);

    // Keyboard dismisses → the sheet restores to the default snap.
    await emulateKeyboard(0);
    await page.waitForTimeout(300);
    const restored = await page.getByTestId("bottom-sheet").boundingBox();
    if (!restored) throw new Error("Sheet has no bounding box");
    expect(Math.abs(restored.height - 0.72 * 844)).toBeLessThanOrEqual(24);
    expect(restored.y + restored.height).toBeGreaterThan(844 - 340 + 24);
  });
});
