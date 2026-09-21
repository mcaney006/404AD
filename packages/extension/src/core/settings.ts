import type { Settings } from "./protocol";

const KEY = "settings";

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  rulesets: {},
  cosmeticFiltering: true,
  scriptlets: true,
  // Local counters only. 404AD has no telemetry, no account and no network
  // calls of its own, so "statistics" here means numbers in chrome.storage.local
  // and nowhere else.
  statistics: true,
  shadowMode: true,
  userFilters: "",
  confirmedRiskyFilters: [],
};

let cache: Settings | null = null;

/**
 * Read settings, filling in any key added since the profile was written.
 *
 * The service worker is torn down constantly, so this caches in module scope
 * and is invalidated by {@link saveSettings} and by the storage listener below.
 */
export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(KEY);
  cache = { ...DEFAULT_SETTINGS, ...(stored[KEY] as Partial<Settings> | undefined) };
  return cache;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * Invalidate the cache when another extension context writes.
 *
 * Guarded because this module is also exercised outside an extension realm (unit
 * tests, and any future non-Chromium host). Registering a listener at import
 * time is a side effect; refusing to crash without the API is the price of
 * keeping the module importable.
 */
function onStorageChanged(key: string, invalidate: () => void): void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && key in changes) invalidate();
  });
}

onStorageChanged(KEY, () => {
  cache = null;
});
