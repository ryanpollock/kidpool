import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";

export default defineConfig({
  build: {
    outDir: "dist/client",
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
  },
  plugins: [
    react(),
    sentryVitePlugin({
      org: "ryan-pollock",
      project: "javascript-react",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: { filesToDeleteAfterUpload: ["dist/client/assets/*.js.map"] },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
});
