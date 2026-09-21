import type { CosmeticHit, RuleDiagnostic, RuleMatch } from "./protocol";

/**
 * Rule provenance and the recent-match log.
 *
 * `diagnostics.json` maps every DNR rule id back to the filter text, list and
 * line it came from, plus its breakage-risk assessment. It is loaded lazily and
 * cached in worker memory; a service-worker restart simply re-reads it.
 */

interface DiagnosticsFile {
  buildId: string;
  compilerVersion: string;
  network: Record<string, RuleDiagnostic>;
  cosmetic: Record<string, RuleDiagnostic>;
}

let loading: Promise<DiagnosticsFile> | null = null;

export function loadDiagnostics(): Promise<DiagnosticsFile> {
  loading ??= fetch(chrome.runtime.getURL("generated/diagnostics.json")).then(
    (r) => r.json() as Promise<DiagnosticsFile>,
  );
  return loading;
}

export async function ruleMeta(ruleId: number): Promise<RuleDiagnostic | null> {
  const file = await loadDiagnostics();
  return file.network[String(ruleId)] ?? null;
}

/** DNR rule id -> the fields statistics needs, as one map. */
export async function ruleMetaMap(): Promise<
  Map<number, { raw: string; list: string; shadow: boolean; riskScore: number; riskBand: string }>
> {
  const file = await loadDiagnostics();
  const out = new Map<
    number,
    { raw: string; list: string; shadow: boolean; riskScore: number; riskBand: string }
  >();
  for (const [id, d] of Object.entries(file.network)) {
    out.set(Number(id), {
      raw: d.raw,
      list: d.list,
      shadow: d.shadow,
      riskScore: d.riskScore,
      riskBand: d.riskBand,
    });
  }
  return out;
}

export async function shadowRuleIds(): Promise<Set<number>> {
  const file = await loadDiagnostics();
  const out = new Set<number>();
  for (const [id, d] of Object.entries(file.network)) {
    if (d.shadow) out.add(Number(id));
  }
  return out;
}

/**
 * A bounded ring of recent matches per tab.
 *
 * Kept in worker memory only. Diagnostics are for the page in front of you, so
 * persisting them would trade privacy for no benefit.
 */
const RING_SIZE = 200;
const rings = new Map<number, RuleMatch[]>();

export function recordMatch(tabId: number, match: RuleMatch): void {
  if (tabId < 0) return;
  const ring = rings.get(tabId) ?? [];
  ring.push(match);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  rings.set(tabId, ring);
}

export function recentMatches(tabId: number): RuleMatch[] {
  // Newest first: the diagnostics panel reads top-down.
  return (rings.get(tabId) ?? []).toReversed();
}

/**
 * Join each recorded match to the rule it came from.
 *
 * A rule id alone answers nothing. "Blocked by `||doubleclick.net^$third-party`
 * from 404ad-base line 12, risk Low" is a statement the user can act on: they
 * can see the rule, the list, and whether it is the kind of rule that breaks
 * pages.
 */
export async function annotatedMatches(tabId: number): Promise<RuleMatch[]> {
  const matches = recentMatches(tabId);
  if (matches.length === 0) return matches;

  const file = await loadDiagnostics().catch(() => null);
  for (const match of matches) {
    const meta = file?.network[String(match.ruleId)];
    if (!meta) continue;
    // Mutated in place: `matches` is a fresh array this function just built,
    // so copying every entry to change five fields buys nothing.
    match.raw = meta.raw;
    match.list = meta.list;
    match.line = meta.line;
    match.riskScore = meta.riskScore;
    match.riskBand = meta.riskBand;
  }
  return matches;
}

/**
 * Cosmetic hits per tab, reported by the content script.
 *
 * Kept alongside the network ring so one panel can answer both halves of "why
 * did that disappear": a request Chromium refused, or an element 404AD hid.
 */
const cosmeticRings = new Map<number, CosmeticHit[]>();

export function recordCosmetic(tabId: number, hits: CosmeticHit[]): void {
  if (tabId < 0 || hits.length === 0) return;
  const existing = new Map(cosmeticRings.get(tabId)?.map((h) => [h.selector, h]) ?? []);
  for (const hit of hits) {
    const previous = existing.get(hit.selector);
    existing.set(hit.selector, {
      selector: hit.selector,
      count: (previous?.count ?? 0) + hit.count,
      procedural: hit.procedural || (previous?.procedural ?? false),
    });
  }
  const merged = [...existing.values()].sort((a, b) => b.count - a.count).slice(0, RING_SIZE);
  cosmeticRings.set(tabId, merged);
}

export function cosmeticHits(tabId: number): CosmeticHit[] {
  return cosmeticRings.get(tabId) ?? [];
}

export function clearTab(tabId: number): void {
  rings.delete(tabId);
  cosmeticRings.delete(tabId);
}

export function tabBlockedCount(tabId: number): number {
  return (rings.get(tabId) ?? []).filter((m) => !m.shadow).length;
}

export function tabShadowCount(tabId: number): number {
  return (rings.get(tabId) ?? []).filter((m) => m.shadow).length;
}
