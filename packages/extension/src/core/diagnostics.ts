import type { RuleDiagnostic, RuleMatch } from "./protocol";

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

export function clearTab(tabId: number): void {
  rings.delete(tabId);
}

export function tabBlockedCount(tabId: number): number {
  return (rings.get(tabId) ?? []).filter((m) => !m.shadow).length;
}

export function tabShadowCount(tabId: number): number {
  return (rings.get(tabId) ?? []).filter((m) => m.shadow).length;
}
