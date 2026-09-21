import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, test as base, type BrowserContext, type Worker } from "@playwright/test";

/**
 * The directory a human would point "Load unpacked" at.
 *
 * Testing the packaged output rather than the build directory is deliberate: a
 * packaging mistake is exactly the class of bug that only shows up here.
 */
export const EXTENSION_PATH = resolve(import.meta.dirname, "../../../../dist/404ad-chrome-mv3");

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), "404ad-e2e-"));
    const context = await chromium.launchPersistentContext(profile, {
      // `channel: 'chromium'` is load-bearing. Playwright's default headless
      // Chromium is the headless *shell*, which has no extension support at
      // all: the browser launches, pages load, and the service worker silently
      // never registers. Naming the channel selects the full browser, which
      // runs MV3 extensions headlessly.
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    // The worker may already have started before the fixture runs.
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export { expect } from "@playwright/test";
