import { defineConfig } from "@playwright/test";
// These tests create and remove only their own parents/messages. No global cleanup.
export default defineConfig({
  testDir: "./tests",
  testMatch: "chat-enhancements.spec.ts",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "https://kidpool-staging.vercel.app",
    viewport: { width: 1100, height: 1100 },
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },
});
