#!/usr/bin/env node
// Renders a fixed-canvas HTML slide to a single-page PDF using the repo's
// Playwright Chromium. No new dependencies.
//
// Usage: node scripts/render-vision-pdf.mjs docs/carpool-copilot-onepager.html docs/carpool-copilot-onepager.pdf 1280 720
//
// QA built in: the script fails if the content overflows the canvas (an
// investor one-pager must be exactly one page with nothing clipped).

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const [htmlPath, pdfPath, widthArg, heightArg] = process.argv.slice(2);
if (!htmlPath || !pdfPath) {
  console.error("Usage: node scripts/render-vision-pdf.mjs <input.html> <output.pdf> [width] [height]");
  process.exit(1);
}
const width = Number(widthArg) || 1280;
const height = Number(heightArg) || 720;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto("file://" + path.resolve(htmlPath), { waitUntil: "networkidle" });
  await page.waitForTimeout(300); // let system fonts settle

  // Overflow check: the slide must fit the canvas exactly.
  const overflow = await page.evaluate(
    ({ width, height }) => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clipped: document.documentElement.scrollWidth > width || document.documentElement.scrollHeight > height,
    }),
    { width, height },
  );
  if (overflow.clipped) {
    console.error(`FAIL: content overflows the ${width}x${height} canvas (scroll ${overflow.scrollWidth}x${overflow.scrollHeight}).`);
    process.exit(1);
  }

  // Font-size floor: nothing below 12px (the app's own legibility rule).
  const tinyFonts = await page.evaluate(() => {
    const offenders = [];
    for (const el of document.querySelectorAll("*")) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (Number.isFinite(fs) && fs < 12 && el.textContent.trim()) offenders.push(`${el.tagName}.${el.className}: ${fs}px`);
    }
    return offenders;
  });
  if (tinyFonts.length > 0) {
    console.error("FAIL: elements below the 12px legibility floor:", tinyFonts.slice(0, 8));
    process.exit(1);
  }

  mkdirSync(path.dirname(path.resolve(pdfPath)), { recursive: true });
  await page.pdf({
    path: pdfPath,
    width: `${width}px`,
    height: `${height}px`,
    printBackground: true,
    preferCSSPageSize: true,
    pageRanges: "1",
  });
  console.log(`OK: ${pdfPath} (${width}x${height}, no overflow, all fonts >= 12px)`);
} finally {
  await browser.close();
}