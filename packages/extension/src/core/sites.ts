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

export async function loadSites(): Promise<SiteRule[]> {
  if (cache) return cache;
  const stored = await chrome.storage.local.get(KEY);
  cache = (stored[KEY] as SiteRule[] | undefined) ?? [];
  return cache;
}

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

export async function setSiteMode(host: string, mode: SiteMode): Promise<SiteRule[]> {
  const sites = await loadSites();
  const next = sites.filter((s) => s.host !== host);
  // `default` is the absence of a rule, not a rule that says "default".
  if (mode !== "default") {
    next.push({ host, mode, updatedAt: Date.now() });
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
