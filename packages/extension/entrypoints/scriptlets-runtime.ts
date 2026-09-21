import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { youtubeAdapter } from "../src/adapters/youtube";
import { SCRIPTLETS, type Scriptlet } from "../src/scriptlets/library";

/**
 * The main-world scriptlet runtime.
 *
 * Injected by the service worker with `chrome.scripting.executeScript`, after a
 * tiny companion injection has published the per-host configuration on
 * `globalThis.__404AD_SCRIPTLETS__`. This file is part of the packaged
 * extension; nothing here is generated, fetched or evaluated from a string.
 */

interface Entry {
  ruleId: number;
  name: string;
  args: string[];
  shadow: boolean;
}

const REGISTRY: Record<string, Scriptlet> = {
  ...SCRIPTLETS,
  // Site adapters are ordinary scriptlets so a filter list can enable, scope or
  // cancel one with the same syntax as everything else.
  "404ad-yt-player": youtubeAdapter,
};

export default defineUnlistedScript(() => {
  const host = globalThis as unknown as Record<string, unknown>;
  const entries = host.__404AD_SCRIPTLETS__ as Entry[] | undefined;
  if (!Array.isArray(entries) || entries.length === 0) return;

  // A single-page navigation can re-inject the runtime. Running `set-constant`
  // twice is harmless; running a MutationObserver-installing scriptlet twice
  // is not, so every invocation is keyed and run at most once per realm.
  const applied = (host.__404AD_APPLIED__ as Set<string> | undefined) ?? new Set<string>();
  host.__404AD_APPLIED__ = applied;

  for (const entry of entries) {
    if (entry.shadow) continue;
    const key = `${entry.name}(${entry.args.join(",")})`;
    if (applied.has(key)) continue;

    const scriptlet = REGISTRY[entry.name];
    if (!scriptlet) {
      // An unknown name is a list-authoring bug, not a page bug. Say so once.
      console.warn(`404AD: unknown scriptlet "${entry.name}"`);
      continue;
    }
    applied.add(key);
    try {
      scriptlet(entry.args);
    } catch (error) {
      console.warn(`404AD: scriptlet "${entry.name}" failed`, error);
    }
  }

  delete host.__404AD_SCRIPTLETS__;
});
