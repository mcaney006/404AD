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
function makeStorageArea() {
  const data = new Map<string, unknown>();
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
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
}

const local = makeStorageArea();
const session = makeStorageArea();

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "404ad-test",
    lastError: undefined,
    getURL: (path: string) => `chrome-extension://404ad-test/${path}`,
  },
  storage: {
    local,
    session,
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  },
};

/** Reset storage between tests that care about isolation. */
export function resetChromeStorage(): void {
  local.data.clear();
  session.data.clear();
}
