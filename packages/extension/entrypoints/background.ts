import { defineBackground } from "wxt/utils/define-background";
import {
  annotatedMatches,
  clearTab,
  cosmeticHits,
  loadDiagnostics,
  recordCosmetic,
  recordMatch,
  ruleMeta,
  ruleMetaMap,
  shadowRuleIds,
  tabBlockedCount,
  tabShadowCount,
} from "../src/core/diagnostics";
import {
  engineError,
  engineStats,
  explain,
  initEngine,
  isReady,
  resolveDocument,
  selectGeneric,
  validateFilters,
} from "../src/core/engine";
import type { Request, Response, TabState } from "../src/core/protocol";
import { syncRulesets } from "../src/core/rulesets";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/core/settings";
import { loadSites, resolveMode, setSiteMode, syncSessionRules } from "../src/core/sites";
import { flush, recordBlock, recordShadow, reset, snapshot } from "../src/core/stats";
import {
  applyUserFilters,
  clearUserFilters,
  measureSubscriptions,
  userFilterStatus,
} from "../src/core/userfilters";
import {
  addSubscription,
  loadSubscriptions,
  recordCounts,
  refreshSubscriptions,
  removeSubscription,
  setSubscriptionEnabled,
} from "../src/core/subscriptions";

/**
 * The 404AD service worker: the control plane.
 *
 * It never sees a network request. Chromium's declarativeNetRequest engine
 * matches and blocks on its own, and reports back afterwards through
 * `onRuleMatchedDebug`. Everything here is configuration, observation and
 * answering questions from the UI.
 */
export default defineBackground(() => {
  const hiddenByTab = new Map<number, number>();
  let shadowIds: Set<number> = new Set();

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function bootstrap(): Promise<void> {
    await Promise.all([
      syncRulesets(),
      syncSessionRules(),
      initEngine().catch((e) => console.error("404AD: engine init failed", e)),
    ]);
    shadowIds = await shadowRuleIds().catch(() => new Set<number>());

    const settings = await loadSettings();
    if (settings.enabled) {
      // Compiled on every worker start rather than persisted: dynamic rules
      // survive restarts anyway, and recompiling is what installs the user
      // cosmetic index, which does not.
      await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters).catch((e) =>
        console.error("404AD: user filters failed to apply", e),
      );
      // Pull-based refresh, no alarm: only lists that are already stale.
      void refreshStaleSubscriptions();
    }
  }

  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
      void chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
    void bootstrap();
  });
  chrome.runtime.onStartup.addListener(() => void bootstrap());
  // The worker can also be revived by a message; bootstrap is idempotent.
  void bootstrap();

  chrome.runtime.onSuspend?.addListener(() => {
    void flush();
  });

  // -------------------------------------------------------------------------
  // Rule-match feedback
  //
  // Requires `declarativeNetRequestFeedback`, which Chromium grants to unpacked
  // and policy-installed extensions. Without it there are no live statistics
  // and no shadow-mode observations; everything else works unchanged.
  // -------------------------------------------------------------------------

  const feedback = chrome.declarativeNetRequest.onRuleMatchedDebug;
  feedback?.addListener((info) => {
    const { request, rule } = info;
    const shadow = shadowIds.has(rule.ruleId);
    const host = hostOf(request.initiator ?? request.url);

    recordMatch(request.tabId, {
      ruleId: rule.ruleId,
      rulesetId: rule.rulesetId,
      url: request.url,
      type: request.type,
      site: host,
      timestamp: Date.now(),
      shadow,
      // A shadow rule is a priority-1 allow, so it matched without acting.
      action: shadow ? "observed" : "blocked",
      raw: null,
      list: null,
      line: null,
      riskScore: null,
      riskBand: null,
    });

    void loadSettings().then((settings) => {
      if (!settings.statistics) return;
      return shadow ? recordShadow(rule.ruleId, host) : recordBlock(rule.ruleId, host);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    clearTab(tabId);
    hiddenByTab.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A committed navigation resets this tab's counters. `onUpdated` is used
    // rather than `webNavigation` because it needs no extra permission and the
    // worker is already awake: the content script has just messaged it.
    if (changeInfo.status === "loading" && changeInfo.url !== undefined) {
      clearTab(tabId);
      hiddenByTab.delete(tabId);
    }
  });

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
    handle(message, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    // Keep the message channel open for the async reply.
    return true;
  });

  async function handle(
    message: Request,
    sender: chrome.runtime.MessageSender,
  ): Promise<Response<Request["type"]>> {
    switch (message.type) {
      case "document:resolve": {
        const settings = await loadSettings();
        const mode = await resolveMode(message.host);
        const off = !settings.enabled || mode === "off";
        const cosmeticEnabled = !off && settings.cosmeticFiltering && mode === "default";
        const scriptletsEnabled = !off && settings.scriptlets && mode === "default";

        // Scriptlets and cosmetic filtering are separately switchable, so a
        // request with cosmetic filtering off still has scriptlets to deliver.
        if (!cosmeticEnabled && !scriptletsEnabled) {
          return {
            specific: [],
            generic: [],
            styles: [],
            scriptlets: [],
            procedural: [],
            unhideIds: [],
            mode,
            cosmeticEnabled,
            scriptletsEnabled,
          };
        }

        const resolved = await resolveDocument(message.host, message.tokens);
        const keep = <T extends { shadow: boolean }>(items: T[]): T[] =>
          settings.shadowMode ? items.filter((i) => !i.shadow) : items.filter((i) => !i.shadow);

        return {
          ...resolved,
          specific: cosmeticEnabled ? resolved.specific : [],
          generic: cosmeticEnabled ? resolved.generic : [],
          styles: cosmeticEnabled ? resolved.styles : [],
          procedural: cosmeticEnabled ? keep(resolved.procedural) : [],
          scriptlets: scriptletsEnabled ? keep(resolved.scriptlets) : [],
          mode,
          cosmeticEnabled,
          scriptletsEnabled,
        };
      }

      case "document:generic": {
        const settings = await loadSettings();
        const mode = await resolveMode(message.host);
        if (!settings.enabled || !settings.cosmeticFiltering || mode !== "default") {
          return { generic: [] };
        }
        return {
          generic: await selectGeneric(message.tokens, message.unhideIds, message.host),
        };
      }

      case "content:hidden": {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          hiddenByTab.set(tabId, (hiddenByTab.get(tabId) ?? 0) + message.count);
          recordCosmetic(tabId, message.hits);
        }
        return { ok: true };
      }

      case "tab:state": {
        const tabId = message.tabId ?? (await activeTabId());
        return await tabState(tabId);
      }

      case "site:set": {
        await setSiteMode(message.host, message.mode, message.durationMs);
        return { ok: true };
      }

      case "site:list":
        return await loadSites();

      case "settings:get":
        return await loadSettings();

      case "settings:set": {
        const next = await saveSettings(message.patch);
        await syncRulesets();
        await recompileFromStorage();
        shadowIds = await shadowRuleIds().catch(() => shadowIds);
        return next;
      }

      case "stats:get":
        return await snapshot(await ruleMetaMap());

      case "stats:reset":
        await reset();
        return { ok: true };

      case "engine:status": {
        const [stats, settings, enabled] = await Promise.all([
          engineStats(),
          loadSettings(),
          chrome.declarativeNetRequest.getEnabledRulesets(),
        ]);
        const file = await loadDiagnostics().catch(() => null);
        return {
          ready: isReady(),
          buildId: stats?.buildId ?? "",
          error: engineError(),
          networkRules: file ? Object.keys(file.network).length : 0,
          cosmeticGeneric: stats?.genericSelectors ?? 0,
          cosmeticHosts: stats?.hosts ?? 0,
          scriptlets: stats?.scriptlets ?? 0,
          enabledRulesets: enabled,
          feedbackAvailable: feedback !== undefined,
        } satisfies Response<"engine:status"> & { _?: typeof settings };
      }

      case "diagnostics:recent":
        return await annotatedMatches(message.tabId);

      case "diagnostics:cosmetic":
        return cosmeticHits(message.tabId);

      case "shadow:promote": {
        // Promotion is the whole point of shadow mode: a rule that has been
        // observed against real traffic gets moved into the user's own filters,
        // pre-confirmed, because its risk has already been measured rather than
        // guessed at.
        const meta = await ruleMeta(message.ruleId);
        if (!meta) throw new Error(`no such rule: ${message.ruleId}`);

        const current = await loadSettings();
        const already = current.userFilters.split("\n").some((line) => line.trim() === meta.raw);
        const userFilters = already
          ? current.userFilters
          : `${current.userFilters.replace(/\s*$/, "")}\n${meta.raw}\n`.replace(/^\n/, "");

        const confirmed = current.confirmedRiskyFilters.includes(meta.raw)
          ? current.confirmedRiskyFilters
          : [...current.confirmedRiskyFilters, meta.raw];

        const next = await saveSettings({ userFilters, confirmedRiskyFilters: confirmed });
        const status = await applyUserFilters(next.userFilters, next.confirmedRiskyFilters);
        return { promoted: meta.raw, status };
      }

      case "diagnostics:explain":
        return await explain(message.url, message.initiator, message.resourceType);

      case "diagnostics:rule":
        return await ruleMeta(message.ruleId);

      case "filters:validate":
        return await validateFilters(message.text);

      case "filters:apply": {
        const settings = await saveSettings({
          userFilters: message.text,
          confirmedRiskyFilters: message.confirmed,
        });
        return await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters);
      }

      case "filters:status":
        return userFilterStatus();

      case "subs:list":
        return await loadSubscriptions();

      case "subs:add": {
        const list = await addSubscription(message.url);
        await recompileFromStorage();
        return list;
      }

      case "subs:remove": {
        const list = await removeSubscription(message.id);
        await recompileFromStorage();
        return list;
      }

      case "subs:enable": {
        const list = await setSubscriptionEnabled(message.id, message.enabled);
        await recompileFromStorage();
        return list;
      }

      case "subs:refresh": {
        await refreshSubscriptions(message.id);
        await recompileFromStorage();
        return await loadSubscriptions();
      }
    }
  }

  async function tabState(tabId: number): Promise<TabState> {
    const settings = await loadSettings();
    let host = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      host = hostOf(tab.url ?? "");
    } catch {
      host = "";
    }
    const rules = await loadSites();
    const rule = host
      ? rules.find((site) => host === site.host || host.endsWith(`.${site.host}`))
      : undefined;

    return {
      tabId,
      host,
      mode: host ? await resolveMode(host) : "default",
      expiresAt: rule?.expiresAt ?? null,
      blocked: tabBlockedCount(tabId),
      hidden: hiddenByTab.get(tabId) ?? 0,
      shadowMatches: tabShadowCount(tabId),
      enabled: settings.enabled,
    };
  }
});

/** Refresh stale subscriptions, then recompile if anything changed. */
async function refreshStaleSubscriptions(): Promise<void> {
  try {
    const before = await loadSubscriptions();
    const after = await refreshSubscriptions();
    const changed = after.some(
      (s, i) => s.updatedAt !== before[i]?.updatedAt || s.bytes !== before[i]?.bytes,
    );
    if (!changed) return;
    const settings = await loadSettings();
    await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters);
    await recordCounts(await measureSubscriptions());
  } catch (error) {
    console.warn("404AD: subscription refresh failed", error);
  }
}

/** Recompile dynamic rules from whatever is currently in storage. */
async function recompileFromStorage(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    await clearUserFilters();
    return;
  }
  await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters);
  await recordCounts(await measureSubscriptions());
}

async function activeTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? -1;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
