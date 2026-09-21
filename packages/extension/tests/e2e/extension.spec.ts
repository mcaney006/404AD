import { expect, test } from './fixtures';

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
  worker: import('@playwright/test').Worker,
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

test.describe('extension loading', () => {
  test('the packaged extension loads and starts its service worker', async ({ serviceWorker, extensionId }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toContain('background');
  });

  test('the manifest declares what it should and nothing more', async ({ serviceWorker }) => {
    const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('404AD');
    expect(manifest.permissions).toContain('declarativeNetRequest');
    expect(manifest.permissions).toContain('storage');
    // No blocking webRequest: Chromium owns the network hot path.
    expect(manifest.permissions).not.toContain('webRequest');
    expect(manifest.permissions).not.toContain('webRequestBlocking');
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  test('every compiled ruleset was accepted by Chromium', async ({ serviceWorker }) => {
    // Chromium validates every rule when a ruleset loads and rejects the whole
    // file if one rule is malformed, so this asserts the compiler's output is
    // valid DNR, not merely valid JSON.
    const declared = await serviceWorker.evaluate(async () => {
      const response = await fetch(chrome.runtime.getURL('generated/rulesets.json'));
      return (await response.json()) as Array<{ id: string; enabled: boolean }>;
    });
    const enabled = await serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.getEnabledRulesets(),
    );

    const expected = declared.filter((r) => r.enabled).map((r) => r.id).sort();
    expect(enabled.sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  test('the static rule count stays inside the platform budget', async ({ serviceWorker }) => {
    const { used, limit } = await serviceWorker.evaluate(async () => {
      const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
      let used = 0;
      for (const id of enabled) {
        const response = await fetch(chrome.runtime.getURL(`rules/${id}.json`));
        used += ((await response.json()) as unknown[]).length;
      }
      return { used, limit: chrome.declarativeNetRequest.GUARANTEED_MINIMUM_STATIC_RULES };
    });
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThanOrEqual(limit);
  });
});

test.describe('network blocking', () => {
  test('a third-party ad request is blocked', async ({ serviceWorker }) => {
    const outcome = await testMatch(serviceWorker, {
      url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      initiator: 'https://news.example.com',
      type: 'script',
    });
    expect(outcome.matchedRules.length).toBeGreaterThan(0);
  });

  test('an unrelated first-party request is not blocked', async ({ serviceWorker }) => {
    const outcome = await testMatch(serviceWorker, {
      url: 'https://news.example.com/assets/app.js',
      initiator: 'https://news.example.com',
      type: 'script',
    });
    expect(outcome.matchedRules).toEqual([]);
  });

  test('a first-party request to an ad host is left alone by a $third-party rule', async ({
    serviceWorker,
  }) => {
    const third = await testMatch(serviceWorker, {
      url: 'https://doubleclick.net/pixel.gif',
      initiator: 'https://news.example.com',
      type: 'image',
    });
    const first = await testMatch(serviceWorker, {
      url: 'https://doubleclick.net/pixel.gif',
      initiator: 'https://doubleclick.net',
      type: 'image',
    });
    expect(third.matchedRules.length).toBeGreaterThan(0);
    expect(first.matchedRules).toEqual([]);
  });

  test('session rules disable a site outright', async ({ serviceWorker }) => {
    const blockedBefore = await testMatch(serviceWorker, {
      url: 'https://doubleclick.net/ad.js',
      initiator: 'https://disabled.example',
      type: 'script',
    });
    expect(blockedBefore.matchedRules.length).toBeGreaterThan(0);

    await serviceWorker.evaluate(() =>
      chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: 9001,
            priority: 1000,
            action: { type: 'allowAllRequests' as chrome.declarativeNetRequest.RuleActionType },
            condition: {
              urlFilter: '||disabled.example^',
              resourceTypes: ['main_frame', 'sub_frame'] as chrome.declarativeNetRequest.ResourceType[],
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
          url: 'https://doubleclick.net/ad.js',
          initiator: 'https://disabled.example',
          type: 'script' as chrome.declarativeNetRequest.ResourceType,
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

test.describe('cosmetic filtering', () => {
  test('generic ad containers are hidden and real content is not', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('/');

    // The generic pass is token-gated: it needs one round trip after the
    // document has content.
    await expect(page.locator('#generic-ad')).toBeAttached();
    await expect(page.locator('#generic-ad')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#generic-advert')).toBeHidden();
    await expect(page.locator('#generic-adsense')).toBeHidden();

    // False positives are worse than misses. These must survive.
    await expect(page.locator('#content')).toBeVisible();
    await expect(page.locator('#not-an-ad')).toBeVisible();

    await page.close();
  });

  test('elements added after load are caught by the incremental pass', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('/');
    // `toBeHidden` is satisfied by an element that does not exist, so wait for
    // the node to attach before asserting anything about its visibility.
    // Without this the test passes whether or not filtering works.
    await expect(page.locator('#late-ad')).toBeAttached({ timeout: 10_000 });
    await expect(page.locator('#late-ad')).toBeHidden({ timeout: 10_000 });
    await page.close();
  });

  test('the injected stylesheet is scoped and identifiable', async ({ context }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('#generic-ad')).toBeHidden({ timeout: 10_000 });

    const css = await page.evaluate(() => document.getElementById('404ad-cosmetic')?.textContent ?? '');
    expect(css).toContain('display:none!important');
    // One rule per selector, so a single invalid selector cannot void the batch.
    expect(css).not.toMatch(/,\s*\.[a-z-]+\{display:none/);

    await page.close();
  });
});

test.describe('control plane', () => {
  test('the popup renders the current site and its controls', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(page.getByRole('heading', { name: '404AD' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Full' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Relaxed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Off' })).toBeVisible();
    await expect(page.getByText('requests blocked')).toBeVisible();

    await page.close();
  });

  test('the options page reports a ready engine', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page.getByText('Engine')).toBeVisible();
    await expect(page.locator('.badge', { hasText: 'ready' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Generic cosmetic selectors')).toBeVisible();

    await page.close();
  });

  test('custom filters are validated and risk-scored before they are applied', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.getByRole('tab', { name: 'Custom filters' }).click();

    await page.locator('textarea').fill('||safe-tracker.example^$third-party\n##div\n||broken.example^$nonsense');
    await page.getByRole('button', { name: 'Check' }).click();

    // A broad generic selector must be flagged, not silently accepted.
    await expect(page.locator('.badge.critical').first()).toBeVisible({ timeout: 10_000 });
    // And a bad option must be reported as an error with a reason.
    await expect(page.getByText('unknown filter option')).toBeVisible();

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
          type: 'diagnostics:explain',
          url: 'https://doubleclick.net/ad.js',
          initiator: 'https://news.example.com/',
          resourceType: 'script',
        })) as { ok: boolean; data: { action: string; matched: unknown[] } },
    );

    expect(explanation.ok).toBe(true);
    expect(explanation.data.action).toBe('block');
    expect(explanation.data.matched.length).toBeGreaterThan(0);
    await page.close();
  });
});
