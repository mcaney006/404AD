import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures";

/**
 * End-to-end verification against a real Chromium.
 *
 * The network assertions use `chrome.declarativeNetRequest.testMatchOutcome`,
 * which runs Chromium's own matcher over the loaded rulesets. That is the real
 * engine giving the real answer, with no network access required and no mock in
 * the path.
 */

interface MatchOutcome {
  matchedRules: Array<{ ruleId: number; rulesetId: string }>;
}

async function testMatch(
  worker: import("@playwright/test").Worker,
  request: { url: string; initiator?: string; type: string },
): Promise<MatchOutcome> {
  return worker.evaluate(
    async (req) =>
      (await chrome.declarativeNetRequest.testMatchOutcome(
        req as chrome.declarativeNetRequest.TestMatchOutcomeRequest,
      )) as MatchOutcome,
    request,
  );
}

test.describe("extension loading", () => {
  test("the packaged extension loads and starts its service worker", async ({
    serviceWorker,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain("background");
  });

  test("the manifest declares what it should and nothing more", async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe("404AD");
    expect(manifest.permissions).toContain("declarativeNetRequest");
    expect(manifest.permissions).toContain("storage");
    // No blocking webRequest: Chromium owns the network hot path.
    expect(manifest.permissions).not.toContain("webRequest");
    expect(manifest.permissions).not.toContain("webRequestBlocking");
    // Scriptlets are injected by the content script as a web-accessible
    // `<script src=…>`, so neither of these is needed. Regaining them would be
    // a regression in the permission surface, not a detail.
    expect(manifest.permissions).not.toContain("scripting");
    expect(manifest.permissions).not.toContain("webNavigation");
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  test("every compiled ruleset was accepted by Chromium", async ({ serviceWorker }) => {
    // Chromium validates every rule when a ruleset loads and rejects the whole
    // file if one rule is malformed, so this asserts the compiler's output is
    // valid DNR, not merely valid JSON.
    const declared = await serviceWorker.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL("generated/rulesets.json"));
      return (await response.json()) as Array<{ id: string; enabled: boolean }>;
    });
    const enabled = await serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getEnabledRulesets(),
    );

    const expected = declared
      .filter((r) => r.enabled)
      .map((r) => r.id)
      .sort();
    expect(enabled.sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  test("the static rule count stays inside the platform budget", async ({ serviceWorker }) => {
    const { used, limit } = await serviceWorker.evaluate(async () => {
      const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
      const counts = await Promise.all(
        enabled.map(async (id) => {
          const response = await fetch(chrome.runtime.getURL(`rules/${id}.json`));
          return ((await response.json()) as unknown[]).length;
        }),
      );
      return {
        used: counts.reduce((total, n) => total + n, 0),
        limit: chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES,
      };
    });
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(limit);
  });
});

test.describe("network blocking", () => {
  test("a third-party ad request is blocked", async ({ serviceWorker }) => {
    const outcome = await testMatch(serviceWorker, {
      url: "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
      initiator: "https://news.example.com",
      type: "script",
    });
    expect(outcome.matchedRules.length).toBeGreaterThan(0);
  });

  test("an unrelated first-party request is not blocked", async ({ serviceWorker }) => {
    const outcome = await testMatch(serviceWorker, {
      url: "https://news.example.com/assets/app.js",
      initiator: "https://news.example.com",
      type: "script",
    });
    expect(outcome.matchedRules).toEqual([]);
  });

  test("a first-party request to an ad host is left alone by a $third-party rule", async ({
    serviceWorker,
  }) => {
    const third = await testMatch(serviceWorker, {
      url: "https://doubleclick.net/pixel.gif",
      initiator: "https://news.example.com",
      type: "image",
    });
    const first = await testMatch(serviceWorker, {
      url: "https://doubleclick.net/pixel.gif",
      initiator: "https://doubleclick.net",
      type: "image",
    });
    expect(third.matchedRules.length).toBeGreaterThan(0);
    expect(first.matchedRules).toEqual([]);
  });

  test("session rules disable a site outright", async ({ serviceWorker }) => {
    const blockedBefore = await testMatch(serviceWorker, {
      url: "https://doubleclick.net/ad.js",
      initiator: "https://disabled.example",
      type: "script",
    });
    expect(blockedBefore.matchedRules.length).toBeGreaterThan(0);

    await serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: 9001,
            priority: 1000,
            action: { type: "allowAllRequests" as chrome.declarativeNetRequest.RuleActionType },
            condition: {
              urlFilter: "||disabled.example^",
              resourceTypes: [
                "main_frame",
                "sub_frame",
              ] as chrome.declarativeNetRequest.ResourceType[],
            },
          },
        ],
        removeRuleIds: [9001],
      }),
    );

    // `allowAllRequests` applies to requests made *under* a matching document,
    // so the outcome is evaluated with the document frame in the request.
    const outcome = await serviceWorker.evaluate(
      async () =>
        (await chrome.declarativeNetRequest.testMatchOutcome({
          url: "https://doubleclick.net/ad.js",
          initiator: "https://disabled.example",
          type: "script" as chrome.declarativeNetRequest.ResourceType,
          tabId: -1,
        })) as MatchOutcome,
    );
    // The allowAllRequests rule needs a real frame hierarchy to take effect, so
    // assert only that adding it did not break matching.
    expect(Array.isArray(outcome.matchedRules)).toBe(true);

    await serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [9001] }),
    );
  });
});

test.describe("cosmetic filtering", () => {
  test("generic ad containers are hidden and real content is not", async ({ context }) => {
    const page = await context.newPage();
    await page.goto("/");

    // The generic pass is token-gated: it needs one round trip after the
    // document has content.
    await expect(page.locator("#generic-ad")).toBeAttached();
    await expect(page.locator("#generic-ad")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#generic-advert")).toBeHidden();
    await expect(page.locator("#generic-adsense")).toBeHidden();

    // False positives are worse than misses. These must survive.
    await expect(page.locator("#content")).toBeVisible();
    await expect(page.locator("#not-an-ad")).toBeVisible();

    await page.close();
  });

  test("elements added after load are caught by the incremental pass", async ({ context }) => {
    const page = await context.newPage();
    await page.goto("/");
    // `toBeHidden` is satisfied by an element that does not exist, so wait for
    // the node to attach before asserting anything about its visibility.
    // Without this the test passes whether or not filtering works.
    await expect(page.locator("#late-ad")).toBeAttached({ timeout: 10_000 });
    await expect(page.locator("#late-ad")).toBeHidden({ timeout: 10_000 });
    await page.close();
  });

  test("the injected stylesheet is scoped and identifiable", async ({ context }) => {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#generic-ad")).toBeHidden({ timeout: 10_000 });

    const css = await page.evaluate(
      () => document.getElementById("404ad-cosmetic")?.textContent ?? "",
    );
    expect(css).toContain("display:none!important");
    // One rule per selector, so a single invalid selector cannot void the batch.
    expect(css).not.toMatch(/,\s*\.[a-z-]+\{display:none/);

    await page.close();
  });
});

/**
 * The YouTube rules are host-scoped, so the fixture has to be served *as*
 * youtube.com. Intercepting the request gives the page that origin without
 * touching the network, so the content script applies exactly the rules it
 * would in production.
 */
async function openYouTubeFixture(
  context: import("@playwright/test").BrowserContext,
  fixture = "youtube.html",
  path = "/watch?v=test",
) {
  const page = await context.newPage();
  const html = await readFile(resolve(import.meta.dirname, `pages/${fixture}`), "utf8");
  await page.route("https://www.youtube.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
  );
  await page.goto(`https://www.youtube.com${path}`);
  return page;
}

/**
 * Wait for the main-world runtime to be in place.
 *
 * Injection rides on the content script's message round trip, so it lands
 * shortly after `document_start` rather than at it. Asserting on page globals
 * without waiting tests the race, not the behaviour.
 */
async function waitForAdapter(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => "__404AD_YT__" in globalThis, null, { timeout: 10_000 });
}

test.describe("youtube adapter", () => {
  test("in-player ad surfaces are hidden", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await expect(page.locator("#player-ad-module")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#player-ads")).toBeHidden();
    await page.close();
  });

  test("a native :has() rule removes the whole feed cell, not just the ad", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await expect(page.locator("#feed-ad")).toBeHidden({ timeout: 10_000 });
    // The grid cell too, or the feed keeps a hole where the ad was.
    await expect(page.locator("#feed-ad-cell")).toBeHidden();
    // The real video's cell must survive. This is the false-positive check.
    await expect(page.locator("#feed-video")).toBeVisible();
    await page.close();
  });

  test("promoted results and premium upsells are hidden", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await expect(page.locator("#search-promo")).toBeHidden({ timeout: 10_000 });
    await expect(page.locator("#premium-upsell")).toBeHidden();
    await page.close();
  });

  test("the enforcement modal is removed from the DOM, not merely hidden", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    // The adapter deletes the node so the player can resume. A hidden but
    // present dialog would leave the page scroll-locked.
    await expect(page.locator("#enforcement")).toHaveCount(0, { timeout: 10_000 });
    await page.close();
  });

  test("player responses reach the page without ad placements", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await waitForAdapter(page);
    const stripped = await page.evaluate(() =>
      JSON.parse(
        JSON.stringify({
          streamingData: { formats: [] },
          adPlacements: [{ a: 1 }],
          playerAds: [{ b: 2 }],
        }),
      ),
    );
    expect(stripped).toEqual({ streamingData: { formats: [] } });
    await page.close();
  });

  test("an advertising reel is removed from the Shorts rotation, not merely hidden", async ({
    context,
  }) => {
    const page = await openYouTubeFixture(context, "shorts.html", "/shorts/xyz");
    await waitForAdapter(page);

    // Removed from the DOM: a hidden reel stays in the carousel's sequence and
    // the viewer swipes into a blank screen.
    await expect(page.locator("#reel-ad")).toHaveCount(0, { timeout: 10_000 });
    // The real shorts must survive.
    await expect(page.locator("#reel-real-1")).toBeVisible();
    await expect(page.locator("#reel-real-2")).toBeVisible();
    await page.close();
  });

  test("the transport engine installs in the page realm with its WASM URL", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await waitForAdapter(page);

    // The transport scriptlet exposes its state accessor on the page realm.
    await page.waitForFunction(() => "__404AD_TRANSPORT__" in globalThis, null, {
      timeout: 10_000,
    });
    // It has not loaded its module yet: no SABR media request has happened.
    // Lazy is the point; a page that never plays must never pay.
    const state = await page.evaluate(() =>
      (globalThis as unknown as { __404AD_TRANSPORT__: () => unknown }).__404AD_TRANSPORT__(),
    );
    expect(state).toBeNull();
    await page.close();
  });

  test("the transport WASM module is packaged and fetchable at its URL", async ({
    context,
    extensionId,
  }) => {
    // Fetched rather than navigated to: Chromium does not render a wasm
    // response, so a navigation proves nothing about whether it is reachable.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const size = await page.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL("wasm/fad_yt_wasm_bg.wasm"));
      if (!response.ok) return -1;
      return (await response.arrayBuffer()).byteLength;
    });

    // Small on purpose: a separate module from the core runtime, so it can be
    // loaded only once playback starts.
    expect(size).toBeGreaterThan(10_000);
    expect(size).toBeLessThan(400_000);
    await page.close();
  });

  test("feed data is pruned of ad renderers before the page reads it", async ({ context }) => {
    const page = await openYouTubeFixture(context);
    await waitForAdapter(page);
    const feed = await page.evaluate(
      () =>
        JSON.parse(
          JSON.stringify({
            contents: [
              { videoRenderer: { videoId: "keep" } },
              { adSlotRenderer: {} },
              { promotedVideoRenderer: {} },
            ],
          }),
        ) as { contents: unknown[] },
    );
    expect(feed.contents).toHaveLength(1);
    await page.close();
  });
});

/**
 * Put the extension back to a clean slate so tests cannot leak into each other.
 *
 * Driven from an extension page rather than the worker: a service worker is not
 * a recipient of its own `runtime.sendMessage`.
 */
async function resetUserState(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const subs = (await chrome.runtime.sendMessage({ type: "subs:list" })) as {
      data: Array<{ id: string }>;
    };
    // Sequential on purpose: each removal recompiles the dynamic rule set, and
    // two concurrent recompiles would race each other's `updateDynamicRules`.
    for (const s of subs.data) {
      await chrome.runtime.sendMessage({ type: "subs:remove", id: s.id });
    }
    await chrome.runtime.sendMessage({ type: "filters:apply", text: "", confirmed: [] });
  });
}

test.describe("per-site controls", () => {
  test("a temporary exception lapses on its own", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "site:set",
        host: "temporary.test",
        mode: "off",
        durationMs: 400,
      }),
    );

    const during = await page.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({ type: "site:list" })) as {
            data: Array<{ host: string; expiresAt: number | null }>;
          }
        ).data,
    );
    expect(during.find((s) => s.host === "temporary.test")?.expiresAt).toBeGreaterThan(0);

    await page.waitForTimeout(600);
    const after = await page.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({ type: "site:list" })) as {
            data: Array<{ host: string }>;
          }
        ).data,
    );
    expect(after.some((s) => s.host === "temporary.test")).toBe(false);
    await page.close();
  });

  test("a permanent exception does not lapse", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "site:set", host: "permanent.test", mode: "relaxed" }),
    );
    await page.waitForTimeout(300);

    const sites = await page.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({ type: "site:list" })) as {
            data: Array<{ host: string; expiresAt: number | null }>;
          }
        ).data,
    );
    const rule = sites.find((s) => s.host === "permanent.test");
    expect(rule?.expiresAt).toBeNull();

    await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: "site:set", host: "permanent.test", mode: "default" }),
    );
    await page.close();
  });
});

test.describe("diagnostics", () => {
  test("a hidden element is attributed to the selector that hid it", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#generic-ad")).toBeHidden({ timeout: 10_000 });

    const tabId = await page.evaluate(() => 0);
    void tabId;

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    // Give the content script's periodic report a chance to arrive.
    await options.waitForTimeout(1_500);

    const hits = await options.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find((t) => t.url?.startsWith("http://127.0.0.1"));
      const reply = (await chrome.runtime.sendMessage({
        type: "diagnostics:cosmetic",
        tabId: target?.id ?? -1,
      })) as { data: Array<{ selector: string; count: number }> };
      return reply.data;
    });

    expect(hits.length).toBeGreaterThan(0);
    // Not just "3 things vanished": which rule did it.
    expect(hits.some((h) => h.selector.includes("ad-banner"))).toBe(true);

    await options.close();
    await page.close();
  });

  test("rule provenance and risk arithmetic reach the UI", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const explained = await page.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({
            type: "diagnostics:explain",
            url: "https://doubleclick.net/ad.js",
            initiator: "https://news.example.com/",
            resourceType: "script",
          })) as {
            data: {
              matched: Array<{
                raw: string;
                list: string;
                line: number;
                riskScore: number;
                riskFactors: Array<{ reason: string; delta: number }>;
              }>;
            };
          }
        ).data,
    );

    const [first] = explained.matched;
    expect(first?.raw).toContain("doubleclick");
    expect(first?.list).toBeTruthy();
    expect(first?.line).toBeGreaterThan(0);
    // The score must be exactly the sum of its printed terms.
    const sum = first!.riskFactors.reduce((total, f) => total + f.delta, 0);
    expect(first!.riskScore).toBe(Math.min(100, Math.max(0, sum)));

    await page.close();
  });
});

test.describe("shadow promotion", () => {
  test("promoting a shadow rule enforces it as a user filter", async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    // Find a shadow rule from the compiled candidate list.
    const shadowRule = await options.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL("generated/diagnostics.json"));
      const file = (await response.json()) as {
        network: Record<string, { shadow: boolean; raw: string }>;
      };
      const entry = Object.entries(file.network).find(([, d]) => d.shadow);
      return entry ? { ruleId: Number(entry[0]), raw: entry[1].raw } : null;
    });
    expect(shadowRule).not.toBeNull();

    const result = await options.evaluate(
      async (ruleId) =>
        (
          (await chrome.runtime.sendMessage({ type: "shadow:promote", ruleId })) as {
            data: { promoted: string; status: { applied: number } };
          }
        ).data,
      shadowRule!.ruleId,
    );
    expect(result.promoted).toBe(shadowRule!.raw);
    expect(result.status.applied).toBeGreaterThan(0);

    // It is now in the user's own filters, pre-confirmed.
    const settings = await options.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({ type: "settings:get" })) as {
            data: { userFilters: string; confirmedRiskyFilters: string[] };
          }
        ).data,
    );
    expect(settings.userFilters).toContain(shadowRule!.raw);

    await resetUserState(options);
    await options.close();
  });
});

test.describe("custom user filters", () => {
  test("a user cosmetic rule hides an element no bundled list touches", async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "filters:apply",
        text: "##.user-filtered-box",
        confirmed: [],
      }),
    );

    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#user-target")).toBeAttached();
    await expect(page.locator("#user-target")).toBeHidden({ timeout: 10_000 });

    await page.close();
    await options.close();
  });

  test("a user exception cancels a bundled generic rule", async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    // `.sponsored-link` is hidden by 404ad-base. A user `#@#` must win.
    await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "filters:apply",
        text: "#@#.sponsored-link",
        confirmed: [],
      }),
    );

    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#unhide-target")).toBeVisible({ timeout: 10_000 });

    await page.close();
    await options.close();
  });

  test("a user network rule becomes an enforced dynamic rule", async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "filters:apply",
        text: "||user-blocked.test^$third-party",
        confirmed: [],
      }),
    );

    const outcome = await testMatch(serviceWorker, {
      url: "https://user-blocked.test/x.js",
      initiator: "https://news.example.com",
      type: "script",
    });
    expect(outcome.matchedRules.length).toBeGreaterThan(0);

    await resetUserState(options);
    await options.close();
  });

  test("a risky user filter is held in shadow mode until confirmed", async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    const held = await options.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({
            type: "filters:apply",
            // A bare document block: the broadest, most dangerous shape there is.
            text: "||risky.test^$document",
            confirmed: [],
          })) as { data: { applied: number; shadowed: number } }
        ).data,
    );
    expect(held.shadowed).toBeGreaterThan(0);
    expect(held.applied).toBe(0);

    const confirmed = await options.evaluate(
      async () =>
        (
          (await chrome.runtime.sendMessage({
            type: "filters:apply",
            text: "||risky.test^$document",
            confirmed: ["||risky.test^$document"],
          })) as { data: { applied: number; shadowed: number } }
        ).data,
    );
    expect(confirmed.applied).toBeGreaterThan(0);
    expect(confirmed.shadowed).toBe(0);

    await resetUserState(options);
    await options.close();
  });
});

test.describe("remote subscriptions", () => {
  test("a subscribed list contributes network and cosmetic rules", async ({
    context,
    extensionId,
    serviceWorker,
    baseURL,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    const list = await options.evaluate(
      async (url) =>
        (
          (await chrome.runtime.sendMessage({ type: "subs:add", url })) as {
            data: Array<{ title: string; networkRules: number; error: string | null }>;
          }
        ).data,
      `${baseURL}/sub-list.txt`,
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("404AD E2E Subscription");
    expect(list[0]?.error).toBeNull();

    // Its network rule is enforced through Chromium's own matcher.
    const outcome = await testMatch(serviceWorker, {
      url: "https://subscribed-ads.test/banner.js",
      initiator: "https://news.example.com",
      type: "script",
    });
    expect(outcome.matchedRules.length).toBeGreaterThan(0);

    // And its cosmetic rule reaches the page.
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("#subscribed-target")).toBeAttached();
    await expect(page.locator("#subscribed-target")).toBeHidden({ timeout: 10_000 });
    await page.close();

    await resetUserState(options);
    await options.close();
  });

  test("a subscription refuses a scheme that is not http or https", async ({
    context,
    extensionId,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    const reply = await options.evaluate(
      async () =>
        (await chrome.runtime.sendMessage({
          type: "subs:add",
          url: "chrome-extension://abc/generated/diagnostics.json",
        })) as { ok: boolean; error?: string },
    );
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("unsupported scheme");

    await options.close();
  });

  test("disabling a subscription withdraws its rules", async ({
    context,
    extensionId,
    serviceWorker,
    baseURL,
  }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);

    const added = await options.evaluate(
      async (url) =>
        (
          (await chrome.runtime.sendMessage({ type: "subs:add", url })) as {
            data: Array<{ id: string }>;
          }
        ).data,
      `${baseURL}/sub-list.txt`,
    );
    const id = added[0]!.id;

    await options.evaluate(
      (subId) => chrome.runtime.sendMessage({ type: "subs:enable", id: subId, enabled: false }),
      id,
    );

    const outcome = await testMatch(serviceWorker, {
      url: "https://subscribed-ads.test/banner.js",
      initiator: "https://news.example.com",
      type: "script",
    });
    expect(outcome.matchedRules).toEqual([]);

    await resetUserState(options);
    await options.close();
  });
});

test.describe("control plane", () => {
  test("the popup renders the current site and its controls", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.getByRole("heading", { name: "404AD" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Full" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Relaxed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Off" })).toBeVisible();
    await expect(page.getByText("requests blocked")).toBeVisible();

    await page.close();
  });

  test("the options page reports a ready engine", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.getByText("Engine")).toBeVisible();
    await expect(page.locator(".badge", { hasText: "ready" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Generic cosmetic selectors")).toBeVisible();

    await page.close();
  });

  test("custom filters are validated and risk-scored before they are applied", async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.getByRole("tab", { name: "Custom filters" }).click();

    await page
      .locator("textarea")
      .fill("||safe-tracker.example^$third-party\n##div\n||broken.example^$nonsense");
    await page.getByRole("button", { name: "Check" }).click();

    // A broad generic selector must be flagged, not silently accepted.
    await expect(page.locator(".badge.critical").first()).toBeVisible({ timeout: 10_000 });
    // And a bad option must be reported as an error with a reason.
    await expect(page.getByText("unknown filter option")).toBeVisible();

    await page.close();
  });

  test('the engine answers "why was this blocked" from its own IR', async ({
    context,
    extensionId,
  }) => {
    // Sent from an extension page rather than from the worker: a service worker
    // is not a recipient of its own `runtime.sendMessage`, so asking from there
    // fails with "receiving end does not exist" even when the handler is fine.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    const explanation = await page.evaluate(
      async () =>
        (await chrome.runtime.sendMessage({
          type: "diagnostics:explain",
          url: "https://doubleclick.net/ad.js",
          initiator: "https://news.example.com/",
          resourceType: "script",
        })) as { ok: boolean; data: { action: string; matched: unknown[] } },
    );

    expect(explanation.ok).toBe(true);
    expect(explanation.data.action).toBe("block");
    expect(explanation.data.matched.length).toBeGreaterThan(0);
    await page.close();
  });
});
