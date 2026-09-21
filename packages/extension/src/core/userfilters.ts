import { compileUserFilters, validateFilters } from "./engine";
import type { ValidationResult } from "./protocol";

/**
 * Custom user filters.
 *
 * Two things make this more than "append text to a list":
 *
 *  * Every line is parsed and scored before it is applied, so a typo is
 *    reported with a reason instead of silently doing nothing.
 *  * A line the risk model rates High or above is compiled into **shadow mode**
 *    until the user explicitly confirms it. It still matches, it still shows up
 *    in diagnostics, but it cannot change a single request until confirmed.
 *
 * That turns the most dangerous thing a user can do — hand-write a broad
 * blocking rule — into something observable first and enforced second.
 */

/**
 * Dynamic rule ids start here.
 *
 * Dynamic and static rules live in separate id namespaces, so this is not
 * required for correctness. It is required for *legibility*: a rule id above
 * this line in a diagnostics dump is unambiguously the user's own.
 */
export const USER_RULE_ID_BASE = 1_000_000;

export interface ApplyResult {
  applied: number;
  shadowed: number;
  unsupported: number;
  errors: number;
}

/** Split filter text into the lines that may be enforced and those that may not. */
function partition(
  text: string,
  validation: ValidationResult,
  confirmed: Set<string>,
): { enforced: string; shadowed: string } {
  const enforced: string[] = [];
  const shadowed: string[] = [];

  for (const line of validation.lines) {
    if (line.kind === "comment" || line.kind === "error") continue;
    if (line.needsConfirmation && !confirmed.has(line.raw)) {
      shadowed.push(line.raw);
    } else {
      enforced.push(line.raw);
    }
  }
  return { enforced: enforced.join("\n"), shadowed: shadowed.join("\n") };
}

export async function applyUserFilters(
  text: string,
  confirmedRiskyFilters: string[],
): Promise<ApplyResult> {
  const validation = await validateFilters(text);
  const confirmed = new Set(confirmedRiskyFilters);
  const { enforced, shadowed } = partition(text, validation, confirmed);

  const rules: chrome.declarativeNetRequest.Rule[] = [];
  let unsupported = 0;

  if (enforced.trim()) {
    const compiled = await compileUserFilters(enforced, USER_RULE_ID_BASE, false);
    rules.push(...compiled.rules);
    unsupported += compiled.unsupported.length;
  }
  if (shadowed.trim()) {
    // Offset the shadow bucket so the two compiles cannot produce colliding ids.
    const compiled = await compileUserFilters(shadowed, USER_RULE_ID_BASE + 500_000, true);
    rules.push(...compiled.rules);
    unsupported += compiled.unsupported.length;
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });

  return {
    applied: rules.filter((r) => r.priority !== 1).length,
    shadowed: rules.filter((r) => r.priority === 1).length,
    unsupported,
    errors: validation.errors,
  };
}

/** Remove every dynamic rule. Used when the master switch goes off. */
export async function clearUserFilters(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: [],
  });
}
