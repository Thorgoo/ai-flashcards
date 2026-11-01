import { defineConfig, devices } from "@playwright/test";

// Browser tests of the critical path against the production preview (build + astro preview on
// the Workers runtime). Locally run through `npm run e2e` (scripts/e2e.mjs points the app at the
// local Supabase); in CI the smoke job has already started the preview, so it is reused.
const BASE_URL = "http://localhost:4321";

export default defineConfig({
  testDir: "e2e",
  // The tests share one account and its daily AI limits, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --port 4321",
    url: BASE_URL,
    reuseExistingServer: !!process.env.CI,
    timeout: 180_000,
  },
});
