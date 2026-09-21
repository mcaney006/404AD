import type { SiteMode, SiteRule } from "./protocol";

const KEY = "sites";

/**
 * Session rule ids for per-site disabling.
 *
 * Session rules live in their own id namespace, separate from both static and
 * dynamic rules, so this range cannot collide with anything else.
 */
const SITE_RULE_BASE = 1;

/**
 * Priority for a per-site `allowAllRequests`.
 *
 * Above every static priority, including `$important` blocks: turning 404AD off
 * for a site has to mean *off*, not "off unless a list author disagreed".
 */
const SITE_DISABLE_PRIORITY = 1000;

let cache: SiteRule[] | null = null;

/**
 * Load per-site rules, dropping any that have expired.
 *
 * Expiry is evaluated on read rather than on a timer. A rule that lapsed while
 * the browser was closed should simply be gone when it reopens, and that needs
 * no wakeup to be true.
 */
export async function loadSites(): Promise<SiteRule[]> {
  if (!cache) {
    const stored = await chrome.storage.local.get(KEY);
    cache = ((stored[KEY] as SiteRule[] | undefined) ?? []).map(normalize);
  }

  // Expiry is checked on every read, including cached ones. Checking only on a
  // cold read meant a temporary exception outlived its own deadline for as long
  // as the service worker happened to stay warm.
  const now = Date.now();
  const live = cache.filter((site) => site.expiresAt === null || site.expiresAt > now);
  if (live.length !== cache.length) {
    // Writing fires `storage.onChanged`, which nulls this module's cache. So
    // the pruned list is written first and re-seeded afterwards, and `live` is
    // what gets returned either way.
    await chrome.storage.local.set({ [KEY]: live });
    cache = live;
    // Session rules mirror this list, so they have to shed the lapsed ones too.
    void syncSessionRules(live);
  }
  return live;
}

/** Fill in fields added since a profile was written. */
function normalize(rule: SiteRule): SiteRule {
  // Spread first, default second: a profile written before `expiresAt` existed
  // has the key missing, not set to undefined, so `?? null` is what fills it.
  return { ...rule, expiresAt: rule.expiresAt ?? null };
}

/** Durations the popup offers for a temporary exception. */
export const TEMPORARY_DURATIONS = [
  { label: "10 minutes", ms: 10 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "1 day", ms: 24 * 60 * 60 * 1000 },
] as const;

/** All suffixes of a host with at least two labels, most specific first. */
export function hostSuffixes(host: string): string[] {
  const clean = host.replace(/\.$/, "").toLowerCase();
  const out: string[] = [];
  let current = clean;
  while (current.includes(".")) {
    out.push(current);
    const next = current.slice(current.indexOf(".") + 1);
    if (!next.includes(".")) break;
    current = next;
  }
  if (out.length === 0 && clean) out.push(clean);
  return out;
}

/**
 * The mode in force for a host.
 *
 * The most specific rule wins, so `off` on `app.example.com` survives a
 * `default` on `example.com`.
 */
export async function resolveMode(host: string): Promise<SiteMode> {
  const sites = await loadSites();
  if (sites.length === 0) return "default";
  const byHost = new Map(sites.map((s) => [s.host, s.mode]));
  for (const suffix of hostSuffixes(host)) {
    const mode = byHost.get(suffix);
    if (mode) return mode;
  }
  return "default";
}

export async function setSiteMode(
  host: string,
  mode: SiteMode,
  durationMs?: number,
): Promise<SiteRule[]> {
  const sites = await loadSites();
  const next = sites.filter((s) => s.host !== host);
  // `default` is the absence of a rule, not a rule that says "default".
  if (mode !== "default") {
    const now = Date.now();
    next.push({
      host,
      mode,
      updatedAt: now,
      // A temporary exception is the honest shape for "let me through just this
      // once". Permanent ones quietly accumulate until half the user's sites
      // are unprotected and nobody remembers why.
      expiresAt: durationMs && durationMs > 0 ? now + durationMs : null,
    });
  }
  next.sort((a, b) => a.host.localeCompare(b.host));
  cache = next;
  await chrome.storage.local.set({ [KEY]: next });
  await syncSessionRules(next);
  return next;
}

/**
 * Mirror `off` sites into session DNR rules.
 *
 * Session rules are cheap, are never persisted to disk, and are rebuilt on every
 * worker start, which is exactly right for something derived from storage.
 */
export async function syncSessionRules(sites?: SiteRule[]): Promise<void> {
  const rules = sites ?? (await loadSites());
  const disabled = rules.filter((s) => s.mode === "off");

  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules: chrome.declarativeNetRequest.Rule[] = disabled.map((site, i) => ({
    id: SITE_RULE_BASE + i,
    priority: SITE_DISABLE_PRIORITY,
    action: { type: "allowAllRequests" as const },
    condition: {
      // `||host^` also covers every subdomain, matching how the mode resolves.
      urlFilter: `||${site.host}^`,
      resourceTypes: ["main_frame" as const, "sub_frame" as const],
    },
  }));

  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

/**
 * Invalidate the cache when another extension context writes.
 *
 * Guarded so the module stays importable outside an extension realm, which is
 * how `hostSuffixes` and `resolveMode` are unit tested.
 */
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && KEY in changes) cache = null;
  });
}
