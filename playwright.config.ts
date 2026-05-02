import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  expect: {
    timeout: 7_500,
  },
  fullyParallel: false,
  use: {
    baseURL: origin,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "bun apps/api/src/server.mjs",
    url: `${origin}/api/status`,
    reuseExistingServer: false,
    timeout: 15_000,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      APP_ORIGIN: origin,
      WEB_ORIGIN: origin,
      DATA_DIR: ".e2e-data",
    },
  },
});
