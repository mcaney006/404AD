import type { ScriptletEntry } from "./protocol";

/**
 * Main-world scriptlet injection.
 *
 * Scriptlets have to run in the page's own realm, before the page's scripts do,
 * and they need per-host arguments. MV3 offers exactly one way to get all three:
 *
 *  1. `executeScript` with `func` + `args` to publish the configuration, and
 *  2. `executeScript` with `files` to run the bundled runtime that reads it.
 *
 * Two calls rather than one because a `func` payload is serialized as source and
 * therefore cannot close over imports, while a `files` payload cannot carry
 * arguments. Splitting them keeps the runtime a normal, bundled, reviewable
 * module instead of one giant stringified function.
 *
 * Neither step evaluates remote or generated code: the runtime is a file inside
 * the packaged extension.
 */

const RUNTIME_FILE = "/scriptlets-runtime.js";

/** Published into the page realm for the runtime to pick up. */
function publishConfig(entries: ScriptletEntry[]): void {
  Object.defineProperty(globalThis, "__404AD_SCRIPTLETS__", {
    value: entries,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

export async function injectScriptlets(
  tabId: number,
  frameId: number,
  entries: ScriptletEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const target: chrome.scripting.InjectionTarget = { tabId, frameIds: [frameId] };

  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    func: publishConfig,
    args: [entries],
  });
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    files: [RUNTIME_FILE],
  });
}
