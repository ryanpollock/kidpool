import { defineConfig } from "@playwright/test";

const testPort = Number(process.env.MOBILE_RUNTIME_TEST_PORT ?? 4174);
const isLocal = process.env.TEST_DB_TARGET === "local";
const devCommand = isLocal
  ? `npm run dev:test -- --port ${testPort}`
  : `npm run dev:staging -- --port ${testPort}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 2,
  use: {
    baseURL: `http://127.0.0.1:${testPort}`,
    viewport: { width: 1100, height: 1100 },
    video: "on",
  },
  webServer: {
    command: devCommand,
    url: `http://127.0.0.1:${testPort}/tests/runtime-fixture.html`,
    reuseExistingServer: process.env.MOBILE_RUNTIME_TEST_PORT == null,
  },
});