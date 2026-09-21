import type { ShadowObservation, StatsSnapshot } from "./protocol";

/**
 * Local-only adaptive statistics.
 *
 * Everything here stays in `chrome.storage.local`. The numbers exist to answer
 * three questions the user or the maintainer can act on:
 *
 *  * How much is being blocked, and where?
 *  * Which rules have never matched? (prune candidates)
 *  * Which shadow rules match often enough to be worth promoting?
 *
 * Writes are coalesced: rule matches arrive in bursts during page load, and
 * one storage write per match would be both slow and pointless.
 */

const KEY = "stats";
const FLUSH_DELAY_MS = 4_000;
const MAX_DAYS = 30;
const MAX_SITES = 200;
const MAX_TRACKED_RULES = 20_000;

interface StatsState {
  totalBlocked: number;
  since: number;
  /** ISO day -> counters. */
  daily: Record<string, { blocked: number; shadow: number }>;
  /** Host -> blocked count. */
  sites: Record<string, number>;
  /** DNR rule id -> times matched. Absent means never matched. */
  ruleHits: Record<number, number>;
  /** Shadow rule id -> observation. */
  shadow: Record<number, { matches: number; hosts: string[]; firstSeen: number; lastSeen: number }>;
}

function emptyState(): StatsState {
  return {
    totalBlocked: 0,
    since: Date.now(),
    daily: {},
    sites: {},
    ruleHits: {},
    shadow: {},
  };
}

let state: StatsState | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

async function ensure(): Promise<StatsState> {
  if (state) return state;
  const stored = await chrome.storage.local.get(KEY);
  state = { ...emptyState(), ...(stored[KEY] as Partial<StatsState> | undefined) } as StatsState;
  return state;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function scheduleFlush(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY_MS);
}

/** Write pending counters. Also called on worker suspend so nothing is lost. */
export async function flush(): Promise<void> {
  if (!dirty || !state) return;
  dirty = false;
  prune(state);
  await chrome.storage.local.set({ [KEY]: state });
}

/**
 * Bound every unbounded map.
 *
 * ponytail: plain sort-and-truncate, O(n log n) on each flush. With a 200-site
 * and 30-day ceiling that is a few hundred entries, which is nothing next to the
 * storage write it precedes. Upgrade path: a min-heap, if the caps ever grow by
 * two orders of magnitude.
 */
function prune(s: StatsState): void {
  const days = Object.keys(s.daily).sort();
  for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) {
    delete s.daily[day];
  }

  const sites = Object.entries(s.sites);
  if (sites.length > MAX_SITES) {
    sites.sort((a, b) => b[1] - a[1]);
    s.sites = Object.fromEntries(sites.slice(0, MAX_SITES));
  }

  const hits = Object.keys(s.ruleHits);
  if (hits.length > MAX_TRACKED_RULES) {
    const entries = Object.entries(s.ruleHits).sort((a, b) => b[1] - a[1]);
    s.ruleHits = Object.fromEntries(entries.slice(0, MAX_TRACKED_RULES));
  }
}

export async function recordBlock(ruleId: number, host: string): Promise<void> {
  const s = await ensure();
  s.totalBlocked += 1;
  const day = today();
  (s.daily[day] ??= { blocked: 0, shadow: 0 }).blocked += 1;
  if (host) s.sites[host] = (s.sites[host] ?? 0) + 1;
  s.ruleHits[ruleId] = (s.ruleHits[ruleId] ?? 0) + 1;
  scheduleFlush();
}

/**
 * Record a shadow-rule match.
 *
 * A shadow rule is a priority-1 `allow` that can never outrank a real block, so
 * this is a pure observation: the request went through exactly as it would have
 * with the rule absent.
 */
export async function recordShadow(ruleId: number, host: string): Promise<void> {
  const s = await ensure();
  const day = today();
  (s.daily[day] ??= { blocked: 0, shadow: 0 }).shadow += 1;

  const now = Date.now();
  const entry = (s.shadow[ruleId] ??= { matches: 0, hosts: [], firstSeen: now, lastSeen: now });
  entry.matches += 1;
  entry.lastSeen = now;
  // Distinct hosts is the signal that separates "one noisy site" from
  // "worth promoting". Cap the sample; the count is what matters.
  if (host && entry.hosts.length < 50 && !entry.hosts.includes(host)) {
    entry.hosts.push(host);
  }
  scheduleFlush();
}

export interface RuleMeta {
  raw: string;
  list: string;
  shadow: boolean;
  riskScore: number;
  riskBand: string;
}

export async function snapshot(meta: Map<number, RuleMeta>, limit = 25): Promise<StatsSnapshot> {
  const s = await ensure();

  const daily = Object.entries(s.daily)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, blocked: v.blocked, shadow: v.shadow }));

  const topSites = Object.entries(s.sites)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([host, blocked]) => ({ host, blocked }));

  // A rule that has never fired is either dead weight or aimed at something the
  // user does not visit. Either way it is the first thing to look at when the
  // rule budget gets tight.
  const coldRules: StatsSnapshot["coldRules"] = [];
  for (const [ruleId, info] of meta) {
    if (info.shadow) continue;
    if (!s.ruleHits[ruleId]) {
      coldRules.push({ ruleId, raw: info.raw, list: info.list });
      if (coldRules.length >= limit) break;
    }
  }

  const shadow: ShadowObservation[] = Object.entries(s.shadow)
    .map(([id, v]) => {
      const ruleId = Number(id);
      const info = meta.get(ruleId);
      return {
        ruleId,
        raw: info?.raw ?? `rule ${ruleId}`,
        list: info?.list ?? "unknown",
        matches: v.matches,
        distinctHosts: v.hosts.length,
        firstSeen: v.firstSeen,
        lastSeen: v.lastSeen,
        riskScore: info?.riskScore ?? 0,
        riskBand: info?.riskBand ?? "low",
      };
    })
    .sort((a, b) => b.matches - a.matches)
    .slice(0, limit);

  return { totalBlocked: s.totalBlocked, daily, topSites, coldRules, shadow, since: s.since };
}

export async function reset(): Promise<void> {
  state = emptyState();
  dirty = true;
  await flush();
}
