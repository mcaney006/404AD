import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";
import { youtubeAdapter } from "../src/adapters/youtube";
import { SCRIPTLETS, type Scriptlet } from "../src/scriptlets/library";

/**
 * The main-world scriptlet runtime.
 *
 * Loaded by the content script as a `<script src=chrome-extension://…>` element
 * whose `data-404ad-scriptlets` attribute carries the per-host configuration.
 * This file is part of the packaged extension: nothing here is generated,
 * fetched from the network, or evaluated from a string.
 */

interface Entry {
  ruleId: number;
  name: string;
  args: string[];
  shadow: boolean;
}

const REGISTRY: Record<string, Scriptlet> = {
  ...SCRIPTLETS,
  // Site adapters are ordinary scriptlets, so a filter list can enable, scope
  // or cancel one with exactly the same syntax as everything else.
  "404ad-yt-player": youtubeAdapter,
};

function readConfig(): Entry[] {
  // `document.currentScript` is the element the content script just appended,
  // and is only valid while this script is executing.
  const element = document.currentScript as HTMLScriptElement | null;
  const raw = element?.getAttribute("data-404ad-scriptlets");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Entry[]) : [];
  } catch {
    return [];
  }
}

export default defineUnlistedScript(() => {
  const entries = readConfig();
  if (entries.length === 0) return;

  const host = globalThis as unknown as Record<string, unknown>;
  // A single-page navigation can inject the runtime again. Running
  // `set-constant` twice is harmless; running a MutationObserver-installing
  // scriptlet twice is not, so each invocation is keyed and runs at most once.
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
});
