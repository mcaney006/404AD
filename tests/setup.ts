import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://test.404ad.local/" });

/**
 * A minimal `chrome` stand-in for unit tests.
 *
 * Only the surfaces the core modules actually touch are implemented, and each
 * one is backed by a plain Map rather than a mock framework, so a test that
 * writes a setting and reads it back exercises real round-trip behaviour
 * instead of an assertion about a call.
 *
 * Anything not implemented here is deliberately absent: a module that reaches
 * for an unimplemented API should fail loudly in a test rather than quietly
 * behave differently from production.
 */
type ChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  area: string,
) => void;

const changeListeners: ChangeListener[] = [];

function makeStorageArea(areaName: string) {
  const data = new Map<string, unknown>();

  /**
   * Notify listeners, exactly as Chrome does.
   *
   * Without this the stub silently diverges from production on the one
   * behaviour several core modules depend on: a module-level cache that is
   * invalidated by `storage.onChanged`. A test against a stub that never fires
   * the event passes while the real thing serves stale data.
   */
  const announce = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
    for (const listener of changeListeners) listener(changes, areaName);
  };

  return {
    data,
    async get(keys?: string | string[] | null) {
      if (keys === undefined || keys === null) return Object.fromEntries(data);
      const list = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (data.has(key)) out[key] = data.get(key);
      }
      return out;
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: data.get(key), newValue: value };
        data.set(key, value);
      }
      announce(changes);
    },
    async remove(keys: string | string[]) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const key of typeof keys === "string" ? [keys] : keys) {
        changes[key] = { oldValue: data.get(key) };
        data.delete(key);
      }
      announce(changes);
    },
    async clear() {
      const changes = Object.fromEntries(
        [...data.keys()].map((key) => [key, { oldValue: data.get(key) }]),
      );
      data.clear();
      announce(changes);
    },
  };
}

const local = makeStorageArea("local");
const session = makeStorageArea("session");

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "404ad-test",
    lastError: undefined,
    getURL: (path: string) => `chrome-extension://404ad-test/${path}`,
  },
  declarativeNetRequest: {
    // Session rules mirror per-site disables. The stub records them so a test
    // can assert on what would have been registered.
    sessionRules: [] as unknown[],
    async getSessionRules() {
      return (
        globalThis as never as { chrome: { declarativeNetRequest: { sessionRules: unknown[] } } }
      ).chrome.declarativeNetRequest.sessionRules;
    },
    async updateSessionRules({ addRules }: { removeRuleIds?: number[]; addRules?: unknown[] }) {
      (
        globalThis as never as { chrome: { declarativeNetRequest: { sessionRules: unknown[] } } }
      ).chrome.declarativeNetRequest.sessionRules = addRules ?? [];
    },
  },
  storage: {
    local,
    session,
    onChanged: {
      addListener: (listener: ChangeListener) => changeListeners.push(listener),
      removeListener: (listener: ChangeListener) => {
        const index = changeListeners.indexOf(listener);
        if (index >= 0) changeListeners.splice(index, 1);
      },
    },
  },
};

/**
 * Reset storage between tests that care about isolation.
 *
 * Cleared through the same path production uses, so module-level caches watching
 * `onChanged` are invalidated rather than left holding the previous test's data.
 */
export function resetChromeStorage(): void {
  const keys = [...local.data.keys()];
  local.data.clear();
  session.data.clear();
  const changes = Object.fromEntries(keys.map((key) => [key, {}]));
  for (const listener of changeListeners) listener(changes, "local");
}
