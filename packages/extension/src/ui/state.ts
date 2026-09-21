import { signal } from "@preact/signals";
import { send } from "../core/messaging";
import type {
  EngineStatus,
  RuleMatch,
  Settings,
  SiteRule,
  StatsSnapshot,
  TabState,
} from "../core/protocol";

/**
 * Shared UI state.
 *
 * The service worker is the single source of truth; these signals are a cache
 * of its answers. Every mutation goes through a message and then re-reads, so
 * the UI can never drift from what the engine is actually doing.
 */

export const settings = signal<Settings | null>(null);
export const tab = signal<TabState | null>(null);
export const status = signal<EngineStatus | null>(null);
export const stats = signal<StatsSnapshot | null>(null);
export const sites = signal<SiteRule[]>([]);
export const matches = signal<RuleMatch[]>([]);
export const error = signal<string | null>(null);

async function guard<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    const value = await run();
    error.value = null;
    return value;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return null;
  }
}

export async function refreshSettings(): Promise<void> {
  const value = await guard(() => send({ type: "settings:get" }));
  if (value) settings.value = value;
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const value = await guard(() => send({ type: "settings:set", patch }));
  if (value) settings.value = value;
}

export async function refreshTab(): Promise<void> {
  const value = await guard(() => send({ type: "tab:state" }));
  if (value) tab.value = value;
}

export async function refreshStatus(): Promise<void> {
  const value = await guard(() => send({ type: "engine:status" }));
  if (value) status.value = value;
}

export async function refreshStats(): Promise<void> {
  const value = await guard(() => send({ type: "stats:get" }));
  if (value) stats.value = value;
}

export async function refreshSites(): Promise<void> {
  const value = await guard(() => send({ type: "site:list" }));
  if (value) sites.value = value;
}

export async function refreshMatches(tabId: number): Promise<void> {
  const value = await guard(() => send({ type: "diagnostics:recent", tabId }));
  if (value) matches.value = value;
}

export async function setMode(
  host: string,
  mode: TabState["mode"],
  durationMs?: number,
): Promise<void> {
  await guard(() => send({ type: "site:set", host, mode, durationMs }));
  await Promise.all([refreshTab(), refreshSites()]);
}

export function formatCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
