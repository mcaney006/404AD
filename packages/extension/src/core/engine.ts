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

/** Everything a content script needs for one document, in one WASM call. */
export async function resolveDocument(host: string, tokens: string[]): Promise<ResolvedDocument> {
  const engine = await cosmeticEngine();
  return engine.resolveDocument(host, tokens) as ResolvedDocument;
}

/**
 * Second-pass generic selection.
 *
 * The first pass runs at `document_start`, when the DOM is empty and no tokens
 * exist yet. This is called once the document has content, and again when a
 * mutation introduces tokens that were not present before.
 */
export async function selectGeneric(tokens: string[], unhideIds: number[]): Promise<string[]> {
  const engine = await cosmeticEngine();
  return engine.selectGeneric(tokens, new Uint32Array(unhideIds));
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
  cosmetic: unknown;
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
