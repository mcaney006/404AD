import initWasm, {
  CosmeticEngine,
  DiagnosticsEngine,
  validateFilters as wasmValidateFilters,
  compileUserFilters as wasmCompileUserFilters,
} from "../wasm/fad_wasm.js";
import type { DocumentPayload, Explanation, ValidationResult } from "./protocol";

/**
 * The WASM facade, owned exclusively by the service worker.
 *
 * Content scripts ask the worker for their cosmetic payload rather than loading
 * the runtime themselves: the module is ~1.5 MB and a page can have dozens of
 * frames. One instance per browser session, not one per frame.
 *
 * The heavy diagnostics engine is loaded separately and only on first use,
 * because most sessions never open the inspector.
 */

let ready: Promise<void> | null = null;
let cosmetic: CosmeticEngine | null = null;
/** Cosmetic rules from user filters and subscriptions, compiled at runtime. */
let userCosmetic: CosmeticEngine | null = null;
let diagnostics: DiagnosticsEngine | null = null;
let diagnosticsReady: Promise<DiagnosticsEngine> | null = null;
let lastError: string | null = null;

async function fetchBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) {
    throw new Error(`${path}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Initialise the WASM module and the cosmetic index.
 *
 * The binary is always read from the packaged extension. 404AD never loads
 * executable code over the network, which is also why the module is fetched by
 * `chrome.runtime.getURL` rather than by a bundler-generated absolute path.
 */
export function initEngine(): Promise<void> {
  ready ??= (async () => {
    try {
      await initWasm({ module_or_path: chrome.runtime.getURL("wasm/fad_wasm_bg.wasm") });
      cosmetic = new CosmeticEngine(await fetchBytes("generated/cosmetic.bin"));
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Let the next call retry: a transient fetch failure during worker
      // startup should not disable cosmetic filtering for the whole session.
      ready = null;
      throw error;
    }
  })();
  return ready;
}

export async function cosmeticEngine(): Promise<CosmeticEngine> {
  await initEngine();
  if (!cosmetic) throw new Error("cosmetic engine unavailable");
  return cosmetic;
}

/** Load the diagnostics engine on first use. */
export async function diagnosticsEngine(): Promise<DiagnosticsEngine> {
  diagnosticsReady ??= (async () => {
    await initEngine();
    diagnostics = new DiagnosticsEngine(await fetchBytes("generated/network-ir.bin"));
    return diagnostics;
  })();
  return diagnosticsReady;
}

export interface ResolvedDocument {
  specific: string[];
  generic: string[];
  styles: string[];
  scriptlets: DocumentPayload["scriptlets"];
  procedural: DocumentPayload["procedural"];
  unhideIds: number[];
}

/**
 * Install the cosmetic index compiled from user filters and subscriptions.
 *
 * A second engine rather than a merged one: the two are compiled at different
 * times from different inputs, and rebuilding the bundled index every time the
 * user edits a line would cost far more than querying two indexes does.
 */
export function setUserCosmetic(bytes: Uint8Array | null): void {
  userCosmetic = bytes && bytes.length > 0 ? new CosmeticEngine(bytes) : null;
}

export function hasUserCosmetic(): boolean {
  return userCosmetic !== null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Everything a content script needs for one document.
 *
 * Results from both indexes are merged, and the user index gets the last word:
 * a `#@#` rule the user wrote cancels a bundled selector. That is the whole
 * point of an exception, and it only works if cancellation is matched on the
 * selector text rather than on index-local ids.
 */
export async function resolveDocument(host: string, tokens: string[]): Promise<ResolvedDocument> {
  const engine = await cosmeticEngine();
  const base = engine.resolveDocument(host, tokens) as ResolvedDocument;
  if (!userCosmetic) return base;

  const extra = userCosmetic.resolveDocument(host, tokens) as ResolvedDocument;
  const cancelled = new Set(userCosmetic.unhideSelectors(host));
  const keep = (selector: string): boolean => !cancelled.has(selector);

  return {
    specific: dedupe([...base.specific, ...extra.specific]).filter(keep),
    generic: dedupe([...base.generic, ...extra.generic]).filter(keep),
    styles: dedupe([...base.styles, ...extra.styles]),
    scriptlets: [...base.scriptlets, ...extra.scriptlets],
    procedural: [...base.procedural, ...extra.procedural],
    unhideIds: base.unhideIds,
  };
}

/**
 * Second-pass generic selection.
 *
 * The first pass runs at `document_start`, when the DOM is empty and no tokens
 * exist yet. This runs once the document has content, and again when a mutation
 * introduces tokens that were not present before.
 */
export async function selectGeneric(
  tokens: string[],
  unhideIds: number[],
  host?: string,
): Promise<string[]> {
  const engine = await cosmeticEngine();
  const base = engine.selectGeneric(tokens, new Uint32Array(unhideIds));
  if (!userCosmetic || host === undefined) return base;

  const extra = userCosmetic.selectGeneric(tokens, new Uint32Array([]));
  const cancelled = new Set(userCosmetic.unhideSelectors(host));
  return dedupe([...base, ...extra]).filter((selector) => !cancelled.has(selector));
}

export async function explain(
  url: string,
  initiator: string,
  resourceType: string,
): Promise<Explanation> {
  const engine = await diagnosticsEngine();
  return engine.explain(url, initiator, resourceType) as Explanation;
}

export async function validateFilters(text: string): Promise<ValidationResult> {
  await initEngine();
  return wasmValidateFilters(text) as ValidationResult;
}

export interface CompiledUserFilters {
  rules: chrome.declarativeNetRequest.Rule[];
  unsupported: Array<{ ruleId: number; raw: string; line: number; reason: string }>;
  /** Postcard bytes, loadable by `CosmeticEngine`. */
  cosmeticBin: Uint8Array;
  networkRules: number;
  cosmeticRules: number;
  parseErrors: Array<{ line: number; raw: string; error: string }>;
}

export async function compileUserFilters(
  text: string,
  idBase: number,
  shadow: boolean,
): Promise<CompiledUserFilters> {
  await initEngine();
  return wasmCompileUserFilters(text, idBase, shadow) as CompiledUserFilters;
}

export interface EngineStats {
  buildId: string;
  genericSelectors: number;
  distinctTokens: number;
  hosts: number;
  entities: number;
  scriptlets: number;
  procedural: number;
}

export async function engineStats(): Promise<EngineStats | null> {
  try {
    const engine = await cosmeticEngine();
    return engine.stats() as EngineStats;
  } catch {
    return null;
  }
}

export function engineError(): string | null {
  return lastError;
}

export function isReady(): boolean {
  return cosmetic !== null;
}
