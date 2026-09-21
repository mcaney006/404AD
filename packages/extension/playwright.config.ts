import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite runs against a real Chromium with the packaged extension loaded
 * from `dist/404ad-chrome-mv3`, which is the same directory a human points
 * "Load unpacked" at. If these tests pass, that load works.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Extension state is global to the browser profile, so parallel workers would
  // fight over the same ruleset and storage.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 8787}`,
  },
  webServer: {
    command: 'bun tests/e2e/server.ts',
    url: `http://127.0.0.1:${process.env.E2E_PORT ?? 8787}/`,
    reuseExistingServer: true,
    stdout: 'ignore',
  },
});
