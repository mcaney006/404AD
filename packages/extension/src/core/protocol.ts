/**
 * The typed message protocol between the service worker, the content scripts and
 * the UI surfaces.
 *
 * Every cross-context call in 404AD goes through this union. A message that is
 * not in the union does not exist, which is what keeps the service worker from
 * growing an untyped `any`-shaped RPC surface.
 */

/** How aggressively 404AD filters one site. */
export type SiteMode =
  /** Everything on: network rules, cosmetic rules, scriptlets. */
  | "default"
  /** Network rules only. Use when cosmetic filtering breaks a layout. */
  | "relaxed"
  /** Nothing at all, enforced by an `allowAllRequests` rule. */
  | "off";

export interface SiteRule {
  host: string;
  mode: SiteMode;
  /** Epoch millis, so the options page can show and sort recent changes. */
  updatedAt: number;
  /**
   * Epoch millis after which this rule stops applying, or null for permanent.
   *
   * A temporary exception is the honest shape for "let me through just this
   * once": a permanent one quietly accumulates until the user is browsing with
   * half their sites unprotected and no memory of why.
   */
  expiresAt: number | null;
}

/** A remote filter list the user subscribed to. Data only: never executed. */
export interface Subscription {
  id: string;
  url: string;
  title: string;
  enabled: boolean;
  addedAt: number;
  /** Epoch millis of the last successful fetch. Zero means never. */
  updatedAt: number;
  networkRules: number;
  cosmeticRules: number;
  bytes: number;
  /** Last fetch error, or null. A failed refresh keeps the previous text. */
  error: string | null;
}

/** What the last user-filter compile produced. */
export interface UserFilterStatus {
  networkRules: number;
  cosmeticRules: number;
  /** Enforced dynamic rules actually registered with Chromium. */
  applied: number;
  /** Rules held in shadow mode pending confirmation. */
  shadowed: number;
  unsupported: number;
  errors: number;
  /** Dynamic rules dropped because Chromium's ceiling was reached. */
  dropped: number;
  limit: number;
}

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  /** Ruleset id -> enabled. Mirrors the compiled categories. */
  rulesets: Record<string, boolean>;
  /** Apply cosmetic filtering at all. */
  cosmeticFiltering: boolean;
  /** Run scriptlets and site adapters. */
  scriptlets: boolean;
  /** Keep local, on-device counters. Nothing ever leaves the browser. */
  statistics: boolean;
  /** Observe shadow-mode candidate rules without enforcing them. */
  shadowMode: boolean;
  /** Custom filters, as raw filter-list text. */
  userFilters: string;
  /**
   * Canonical text of user filters the person has confirmed despite a
   * high breakage-risk score. Anything not listed here stays in shadow mode.
   */
  confirmedRiskyFilters: string[];
}

export interface ScriptletEntry {
  ruleId: number;
  name: string;
  args: string[];
  shadow: boolean;
}

export type ProceduralOp =
  | { HasText: { needle: string; regex: boolean } }
  | { Has: { selector: string } }
  | { Upward: { steps: number | null; selector: string | null } }
  | { MatchesAttr: { name: string; value: string | null } }
  | { MinTextLength: { len: number } };

export interface ProceduralEntry {
  ruleId: number;
  prefix: string | null;
  ops: ProceduralOp[];
  shadow: boolean;
}

/** Everything a content script needs for one document. */
export interface DocumentPayload {
  /** Host-specific hide selectors. */
  specific: string[];
  /** Generic selectors that survived token gating. Empty on the first pass. */
  generic: string[];
  /** Raw `selector { declarations }` strings. */
  styles: string[];
  scriptlets: ScriptletEntry[];
  procedural: ProceduralEntry[];
  unhideIds: number[];
  /** Resolved mode for this host, after per-site rules. */
  mode: SiteMode;
  /** False when the master switch is off or the site is disabled. */
  cosmeticEnabled: boolean;
  scriptletsEnabled: boolean;
}

export interface TabState {
  tabId: number;
  host: string;
  mode: SiteMode;
  /** When this site's exception lapses, or null when permanent or absent. */
  expiresAt: number | null;
  /** Requests blocked on this tab since the last navigation. */
  blocked: number;
  /** Elements hidden by the content script on this tab. */
  hidden: number;
  /** Shadow rules that matched here but changed nothing. */
  shadowMatches: number;
  enabled: boolean;
}

export interface RuleMatch {
  ruleId: number;
  rulesetId: string;
  url: string;
  /** Resource type Chromium matched on: script, image, xmlhttprequest, … */
  type: string;
  /** Host of the document that made the request. */
  site: string;
  timestamp: number;
  shadow: boolean;
  /** What Chromium did: block, allow, redirect, … */
  action: string;
  /** Joined from the compiled diagnostics map, when the rule is a known one. */
  raw: string | null;
  list: string | null;
  line: number | null;
  riskScore: number | null;
  riskBand: string | null;
}

/** An element hidden on the page, reported by the content script. */
export interface CosmeticHit {
  selector: string;
  count: number;
  /** True for a procedural rule evaluated in JavaScript. */
  procedural: boolean;
}

/**
 * One additive term of a risk score, with the number it contributed.
 *
 * The score is not a black box: every term is named, signed and visible, so the
 * arithmetic can be checked by hand rather than trusted.
 */
export interface RiskFactor {
  reason: string;
  delta: number;
}

export interface RuleDiagnostic {
  irId: number;
  raw: string;
  list: string;
  line: number;
  priority: number;
  shadow: boolean;
  riskScore: number;
  riskBand: "low" | "medium" | "high" | "critical";
  riskFactors: RiskFactor[];
}

export interface ExplainedRule extends Omit<RuleDiagnostic, "irId"> {
  ruleId: number;
  action: string;
}

export interface Explanation {
  action: string;
  thirdParty: boolean;
  winner: ExplainedRule | null;
  matched: ExplainedRule[];
}

export interface ValidatedLine {
  line: number;
  raw: string;
  kind: "network" | "cosmetic" | "comment" | "error";
  error: string | null;
  riskScore: number;
  riskBand: "low" | "medium" | "high" | "critical";
  riskFactors: RiskFactor[];
  needsConfirmation: boolean;
}

export interface ValidationResult {
  lines: ValidatedLine[];
  networkRules: number;
  cosmeticRules: number;
  errors: number;
  needsConfirmation: number;
}

/** A shadow rule's observed behaviour, used to decide whether to promote it. */
export interface ShadowObservation {
  ruleId: number;
  raw: string;
  list: string;
  matches: number;
  distinctHosts: number;
  firstSeen: number;
  lastSeen: number;
  riskScore: number;
  riskBand: string;
}

export interface StatsSnapshot {
  /** Total blocks since install. */
  totalBlocked: number;
  /** Per-day totals, newest last. */
  daily: Array<{ day: string; blocked: number; shadow: number }>;
  /** Busiest sites, capped and LRU-evicted. */
  topSites: Array<{ host: string; blocked: number }>;
  /** Rules that have never matched, oldest first. Candidates for pruning. */
  coldRules: Array<{ ruleId: number; raw: string; list: string }>;
  shadow: ShadowObservation[];
  since: number;
}

export interface EngineStatus {
  ready: boolean;
  buildId: string;
  error: string | null;
  networkRules: number;
  cosmeticGeneric: number;
  cosmeticHosts: number;
  scriptlets: number;
  enabledRulesets: string[];
  /** True when Chromium is giving us rule-match feedback. */
  feedbackAvailable: boolean;
}

export type Request =
  | { type: "document:resolve"; host: string; tokens: string[] }
  | { type: "document:generic"; host: string; tokens: string[]; unhideIds: number[] }
  | { type: "content:hidden"; count: number; hits: CosmeticHit[] }
  | { type: "tab:state"; tabId?: number }
  | { type: "site:set"; host: string; mode: SiteMode; durationMs?: number }
  | { type: "site:list" }
  | { type: "settings:get" }
  | { type: "settings:set"; patch: Partial<Settings> }
  | { type: "stats:get" }
  | { type: "stats:reset" }
  | { type: "engine:status" }
  | { type: "diagnostics:recent"; tabId: number }
  | { type: "diagnostics:explain"; url: string; initiator: string; resourceType: string }
  | { type: "diagnostics:rule"; ruleId: number }
  | { type: "filters:validate"; text: string }
  | { type: "filters:apply"; text: string; confirmed: string[] }
  | { type: "filters:status" }
  | { type: "subs:list" }
  | { type: "subs:add"; url: string }
  | { type: "subs:remove"; id: string }
  | { type: "subs:enable"; id: string; enabled: boolean }
  | { type: "subs:refresh"; id?: string }
  | { type: "diagnostics:cosmetic"; tabId: number }
  | { type: "shadow:promote"; ruleId: number };

export interface ResponseMap {
  "document:resolve": DocumentPayload;
  "document:generic": { generic: string[] };
  "content:hidden": { ok: true };
  "tab:state": TabState;
  "site:set": { ok: true };
  "site:list": SiteRule[];
  "settings:get": Settings;
  "settings:set": Settings;
  "stats:get": StatsSnapshot;
  "stats:reset": { ok: true };
  "engine:status": EngineStatus;
  "diagnostics:recent": RuleMatch[];
  "diagnostics:explain": Explanation;
  "diagnostics:rule": RuleDiagnostic | null;
  "filters:validate": ValidationResult;
  "filters:apply": UserFilterStatus;
  "filters:status": UserFilterStatus;
  "subs:list": Subscription[];
  "subs:add": Subscription[];
  "subs:remove": Subscription[];
  "subs:enable": Subscription[];
  "subs:refresh": Subscription[];
  "diagnostics:cosmetic": CosmeticHit[];
  "shadow:promote": { promoted: string; status: UserFilterStatus };
}

export type Response<T extends Request["type"]> = ResponseMap[T];
