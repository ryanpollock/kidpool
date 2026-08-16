import { chromium } from "@playwright/test";

const BASE = "http://localhost:5173";
const errors = [];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 427, height: 952 } });
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(`PAGE ERROR: ${err.message}`));

  await page.goto(`${BASE}/?testAuth=johnson@seed.kidpool|SeedPass123!`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  console.log("=== ACCOUNT SCREEN ===");
  // Open account
  await page.locator(".avatar-button").click().catch(() => {});
  await page.waitForTimeout(2000);
  
  const accountScreen = await page.getByTestId("account-screen").count();
  console.log(`Account screen: ${accountScreen > 0 ? "✅ renders" : "❌ missing"}`);
  
  // Check avatar upload
  const avatarUpload = await page.locator(".account-avatar-upload").count();
  console.log(`Avatar upload: ${avatarUpload > 0 ? "✅ present" : "❌ missing"}`);
  
  // Check kid phone input
  const phoneRows = await page.locator(".child-phone-row").count();
  console.log(`Kid phone rows: ${phoneRows > 0 ? `✅ ${phoneRows} found` : "⚠️  none (may have no kids)"}`);
  
  // Check children section
  const childRows = await page.locator(".child-photo-thumb").count();
  console.log(`Child photo thumbnails: ${childRows}`);
  
  // Check if child photo is tappable (PhotoButton)
  const photoButtons = await page.locator("button.child-photo-thumb").count();
  console.log(`Tappable child photos: ${photoButtons}`);

  console.log("\n=== THIS WEEK TAB ===");
  await page.getByTestId("nav-home").click().catch(() => {});
  await page.waitForTimeout(500);
  await page.getByTestId("nav-week").click().catch(() => {});
  await page.waitForTimeout(2000);
  
  // Check week list content
  const weekDays = await page.locator(".week-day").count();
  console.log(`Week day rows: ${weekDays}`);
  
  // Check for day-name labels (should show "Tuesday Morning" not just "Morning")
  const legLabels = await page.locator(".leg small").allTextContents().catch(() => []);
  console.log(`Leg labels: ${JSON.stringify(legLabels.slice(0, 4))}`);
  
  // Check for today emphasis (should NOT appear on Saturday)
  const todayChip = await page.locator(".today-chip").count();
  console.log(`Today chips: ${todayChip} (expected 0 on Saturday)`);

  console.log("\n=== DIRECTORY ===");
  await page.getByTestId("nav-home").click().catch(() => {});
  await page.waitForTimeout(500);
  await page.getByTestId("directory-link").click().catch(() => {});
  await page.waitForTimeout(2000);
  
  // Check tappable parent names
  const parentButtons = await page.getByTestId(/directory-parent-/).count();
  console.log(`Tappable parent names: ${parentButtons}`);
  
  if (parentButtons > 0) {
    // Click first parent to open detail
    await page.getByTestId(/directory-parent-/).first().click();
    await page.waitForTimeout(2000);
    const parentDetail = await page.getByTestId("parent-detail-screen").count();
    console.log(`Parent detail screen: ${parentDetail > 0 ? "✅ renders" : "❌ missing"}`);
    
    if (parentDetail > 0) {
      const avatar = await page.locator(".parent-detail-avatar").count();
      console.log(`Large parent avatar: ${avatar > 0 ? "✅ present" : "❌ missing"}`);
      const childGrid = await page.locator(".child-photo-grid").count();
      console.log(`Children grid: ${childGrid > 0 ? "✅ present" : "❌ missing"}`);
      const callButtons = await page.locator(".call-kid-link").count();
      console.log(`Call kid buttons: ${callButtons}`);
    }
  }

  console.log("\n=== ERRORS ===");
  if (errors.length === 0) {
    console.log("✅ No console errors across all screens");
  } else {
    console.log(`❌ ${errors.length} console errors:`);
    errors.slice(0, 10).forEach(e => console.log(`   ${e}`));
  }

  await browser.close();
}

run().catch(e => { console.error("Crashed:", e); process.exit(1); });
