import type { ScriptletEntry } from "../core/protocol";

/**
 * Main-world scriptlet injection, from the content script.
 *
 * Scriptlets have to run in the page's own realm, and they need per-host
 * arguments. The obvious MV3 route is `chrome.scripting.executeScript` from the
 * service worker on a `webNavigation` event, and that route has a defect that
 * only shows up in a cold profile: the worker is not reliably awake when the
 * event fires, so the injection silently never happens. Cosmetic filtering was
 * unaffected because the content script wakes the worker itself with
 * `runtime.sendMessage`.
 *
 * So injection lives here instead, on the response the content script already
 * waits for. A `<script>` element pointing at a web-accessible extension
 * resource carries the config in a data attribute:
 *
 *   * nothing is evaluated from a string, and nothing is fetched remotely;
 *   * Chromium exempts extension-resource scripts injected by a content script
 *     from the page's own CSP, so this works on sites that forbid inline script;
 *   * it needs neither the `scripting` nor the `webNavigation` permission.
 */

const RUNTIME_PATH = "scriptlets-runtime.js";
const TRANSPORT_WASM_PATH = "wasm/fad_yt_wasm_bg.wasm";

/**
 * Supply arguments only the extension realm can produce.
 *
 * The main world has no `chrome` APIs, so a scriptlet that needs an extension
 * URL cannot build one. The content script fills it in here rather than the
 * runtime guessing, which also keeps the URL out of the filter list.
 */
function withRuntimeArgs(entry: ScriptletEntry): ScriptletEntry {
  if (entry.name !== "404ad-yt-transport") return entry;
  return { ...entry, args: [chrome.runtime.getURL(TRANSPORT_WASM_PATH), ...entry.args] };
}
const CONFIG_ATTRIBUTE = "data-404ad-scriptlets";

let injected = false;

export function injectScriptlets(entries: ScriptletEntry[]): boolean {
  if (injected || entries.length === 0) return false;

  const active = entries.filter((entry) => !entry.shadow).map(withRuntimeArgs);
  if (active.length === 0) return false;
  injected = true;

  const element = document.createElement("script");
  element.src = chrome.runtime.getURL(RUNTIME_PATH);
  element.setAttribute(CONFIG_ATTRIBUTE, JSON.stringify(active));
  // The runtime reads its config from `document.currentScript`, so the element
  // has to be in the document before it executes, and is removed once it has.
  element.addEventListener("load", () => element.remove(), { once: true });

  (document.head ?? document.documentElement).append(element);
  return true;
}

/** Test seam: forget that injection already happened. */
export function resetScriptletInjection(): void {
  injected = false;
}

export { CONFIG_ATTRIBUTE };
