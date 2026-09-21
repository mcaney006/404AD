import { defineContentScript } from "wxt/utils/define-content-script";
import { CosmeticInjector } from "../src/content/cosmetic";
import { injectScriptlets } from "../src/content/scriptlets";
import { ProceduralEngine } from "../src/content/procedural";
import { notify, send } from "../src/core/messaging";

/**
 * The content runtime.
 *
 * Runs in every frame at `document_start`. It does three things and nothing
 * else: apply host-specific cosmetic rules before first paint, feed DOM tokens
 * back for generic selection, and evaluate procedural selectors as the page
 * changes. It never touches the network path.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  async main() {
    const host = location.hostname;
    if (!host) return;

    const injector = new CosmeticInjector();
    const procedural = new ProceduralEngine();
    let reportedHidden = 0;

    // ---- Phase 1: host-specific rules, before the page paints --------------
    let payload;
    try {
      payload = await send({ type: "document:resolve", host, tokens: [] });
    } catch {
      // The worker can be mid-restart at document_start. Cosmetic filtering is
      // best-effort; network blocking is unaffected because Chromium owns it.
      return;
    }
    // Scriptlets first: they patch page globals, and every millisecond of delay
    // is another inline script that may already have read the value.
    if (payload.scriptletsEnabled) injectScriptlets(payload.scriptlets);

    if (!payload.cosmeticEnabled) return;

    injector.hide(payload.specific);
    injector.addStyleRules(payload.styles);
    procedural.setEntries(payload.procedural);

    // ---- Phase 2: generic rules, gated on tokens present in the document ---
    let unhideIds = payload.unhideIds;
    let pending: string[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flushTokens = async (): Promise<void> => {
      flushTimer = null;
      const tokens = pending;
      pending = [];
      if (tokens.length === 0) return;
      try {
        const { generic } = await send({ type: "document:generic", host, tokens, unhideIds });
        injector.hide(generic);
      } catch {
        // Dropped round trip; the next mutation will retry with fresh tokens.
      }
    };

    const scheduleTokenFlush = (): void => {
      if (flushTimer !== null) return;
      // 60 ms is long enough to coalesce a framework's initial render into one
      // round trip and short enough that an ad slot never becomes visible.
      flushTimer = setTimeout(() => void flushTokens(), 60);
    };

    const harvest = (root: ParentNode = document): void => {
      const tokens = injector.harvestTokens(root);
      if (tokens.length === 0) return;
      pending.push(...tokens);
      scheduleTokenFlush();
    };

    const reportHidden = (): void => {
      const total = injector.countHidden() + procedural.hiddenCount;
      if (total === reportedHidden) return;
      notify({ type: "content:hidden", count: total - reportedHidden });
      reportedHidden = total;
    };

    // ---- Phase 3: keep up with the page ------------------------------------
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) harvest(node as Element);
        }
        if (record.type === "attributes" && record.target.nodeType === Node.ELEMENT_NODE) {
          harvest(record.target as Element);
        }
      }
      procedural.schedule();
    });

    const start = (): void => {
      harvest();
      procedural.run();
      reportHidden();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "id"],
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }

    // The count is for the popup badge, so a second of latency costs nothing
    // and a per-mutation recount would cost a lot.
    const counter = setInterval(reportHidden, 1_000);
    addEventListener(
      "pagehide",
      () => {
        observer.disconnect();
        clearInterval(counter);
        if (flushTimer !== null) clearTimeout(flushTimer);
      },
      { once: true },
    );

    // Re-resolve when the user changes this site's mode from the popup.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !("sites" in changes || "settings" in changes)) return;
      void (async () => {
        const next = await send({ type: "document:resolve", host, tokens: [] });
        if (next.scriptletsEnabled) injectScriptlets(next.scriptlets);
        if (!next.cosmeticEnabled) {
          injector.reset();
          procedural.reset();
          procedural.setEntries([]);
          return;
        }
        unhideIds = next.unhideIds;
        injector.hide(next.specific);
        injector.addStyleRules(next.styles);
        procedural.setEntries(next.procedural);
        procedural.schedule();
      })().catch(() => undefined);
    });
  },
});
