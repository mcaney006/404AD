import { defineBackground } from "wxt/utils/define-background";
import {
  clearTab,
  loadDiagnostics,
  recentMatches,
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
import { applyUserFilters, clearUserFilters } from "../src/core/userfilters";

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
    if (settings.enabled && settings.userFilters.trim()) {
      await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters).catch((e) =>
        console.error("404AD: user filters failed to apply", e),
      );
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
      timestamp: Date.now(),
      shadow,
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
        return { generic: await selectGeneric(message.tokens, message.unhideIds) };
      }

      case "content:hidden": {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          hiddenByTab.set(tabId, (hiddenByTab.get(tabId) ?? 0) + message.count);
        }
        return { ok: true };
      }

      case "tab:state": {
        const tabId = message.tabId ?? (await activeTabId());
        return await tabState(tabId);
      }

      case "site:set": {
        await setSiteMode(message.host, message.mode);
        return { ok: true };
      }

      case "site:list":
        return await loadSites();

      case "settings:get":
        return await loadSettings();

      case "settings:set": {
        const next = await saveSettings(message.patch);
        await syncRulesets();
        if (!next.enabled) {
          await clearUserFilters();
        } else if (next.userFilters.trim()) {
          await applyUserFilters(next.userFilters, next.confirmedRiskyFilters);
        } else {
          await clearUserFilters();
        }
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
        return recentMatches(message.tabId);

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
    return {
      tabId,
      host,
      mode: host ? await resolveMode(host) : "default",
      blocked: tabBlockedCount(tabId),
      hidden: hiddenByTab.get(tabId) ?? 0,
      shadowMatches: tabShadowCount(tabId),
      enabled: settings.enabled,
    };
  }
});

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
