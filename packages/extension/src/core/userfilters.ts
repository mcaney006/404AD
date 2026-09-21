import { compileUserFilters, setUserCosmetic, validateFilters } from "./engine";
import type { UserFilterStatus, ValidationResult } from "./protocol";
import { enabledSubscriptionText, loadSubscriptions, subscriptionText } from "./subscriptions";

/**
 * Custom filters and subscriptions, compiled into dynamic rules.
 *
 * Two things make this more than "append text to a list":
 *
 *  * Every line is parsed and scored before it is applied, so a typo is
 *    reported with a reason instead of silently doing nothing.
 *  * A line the risk model rates High or above is compiled into **shadow mode**
 *    until the user confirms it. It still matches and still appears in
 *    diagnostics, but it cannot change a single request until confirmed.
 *
 * That turns the most dangerous thing a user can do — hand-write a broad
 * blocking rule — into something observable first and enforced second.
 */

/**
 * Dynamic rule ids start here.
 *
 * Dynamic and static rules live in separate id namespaces, so this is not
 * required for correctness. It is required for *legibility*: a rule id above
 * this line in a diagnostics dump is unambiguously not from a bundled list.
 */
export const USER_RULE_ID_BASE = 1_000_000;
const SHADOW_ID_OFFSET = 500_000;

/**
 * Chromium's ceiling on dynamic plus session rules.
 *
 * Exceeding it makes the whole `updateDynamicRules` call fail, which would
 * silently drop *every* user rule rather than the surplus. Budgeting here means
 * the surplus is reported instead.
 */
export const DYNAMIC_RULE_LIMIT = 5_000;
/** Session rules are per-site disables; leave room for a generous number. */
const SESSION_RULE_RESERVE = 200;

let lastStatus: UserFilterStatus = {
  networkRules: 0,
  cosmeticRules: 0,
  applied: 0,
  shadowed: 0,
  unsupported: 0,
  errors: 0,
  dropped: 0,
  limit: DYNAMIC_RULE_LIMIT - SESSION_RULE_RESERVE,
};

export function userFilterStatus(): UserFilterStatus {
  return lastStatus;
}

/** Split filter text into the lines that may be enforced and those that may not. */
function partition(
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

/**
 * Compile user filters plus every enabled subscription and register the result.
 *
 * Subscriptions are trusted less than hand-written filters in exactly one way:
 * they are not offered the risk-confirmation prompt, because a user cannot
 * reasonably confirm ten thousand lines. Instead they are enforced as written,
 * which is what subscribing to a list means, and the options page reports what
 * each one contributed.
 */
export async function applyUserFilters(
  userText: string,
  confirmedRiskyFilters: string[],
): Promise<UserFilterStatus> {
  const validation = await validateFilters(userText);
  const confirmed = new Set(confirmedRiskyFilters);
  const { enforced, shadowed } = partition(validation, confirmed);

  const subscriptions = await enabledSubscriptionText();
  const enforcedText = [enforced, subscriptions].filter((t) => t.trim()).join("\n");

  const rules: chrome.declarativeNetRequest.Rule[] = [];
  const cosmeticChunks: Uint8Array[] = [];
  let unsupported = 0;
  let networkRules = 0;
  let cosmeticRules = 0;

  if (enforcedText.trim()) {
    const compiled = await compileUserFilters(enforcedText, USER_RULE_ID_BASE, false);
    rules.push(...compiled.rules);
    cosmeticChunks.push(compiled.cosmeticBin);
    unsupported += compiled.unsupported.length;
    networkRules += compiled.networkRules;
    cosmeticRules += compiled.cosmeticRules;
  }
  if (shadowed.trim()) {
    // Offset so the two compiles cannot produce colliding ids.
    const compiled = await compileUserFilters(shadowed, USER_RULE_ID_BASE + SHADOW_ID_OFFSET, true);
    rules.push(...compiled.rules);
    unsupported += compiled.unsupported.length;
    networkRules += compiled.networkRules;
  }

  // The cosmetic index for the enforced set is the one the content script uses.
  // Shadow cosmetic rules are deliberately not installed: a shadow rule must
  // not change what the page looks like.
  setUserCosmetic(cosmeticChunks[0] ?? null);

  const limit = DYNAMIC_RULE_LIMIT - SESSION_RULE_RESERVE;
  const accepted = rules.slice(0, limit);
  const dropped = rules.length - accepted.length;

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: accepted,
  });

  lastStatus = {
    networkRules,
    cosmeticRules,
    applied: accepted.filter((r) => r.priority !== 1).length,
    shadowed: accepted.filter((r) => r.priority === 1).length,
    unsupported,
    errors: validation.errors,
    dropped,
    limit,
  };
  return lastStatus;
}

/** Per-subscription rule counts, for the options page. */
export async function measureSubscriptions(): Promise<
  Map<string, { networkRules: number; cosmeticRules: number }>
> {
  const counts = new Map<string, { networkRules: number; cosmeticRules: number }>();
  for (const subscription of await loadSubscriptions()) {
    if (!subscription.enabled) {
      counts.set(subscription.id, { networkRules: 0, cosmeticRules: 0 });
      continue;
    }
    const text = await subscriptionText(subscription.id);
    if (!text.trim()) continue;
    // Compiled purely to count; the ids are thrown away.
    const compiled = await compileUserFilters(text, USER_RULE_ID_BASE, false);
    counts.set(subscription.id, {
      networkRules: compiled.networkRules,
      cosmeticRules: compiled.cosmeticRules,
    });
  }
  return counts;
}

/** Remove every dynamic rule. Used when the master switch goes off. */
export async function clearUserFilters(): Promise<void> {
  setUserCosmetic(null);
  lastStatus = { ...lastStatus, applied: 0, shadowed: 0, dropped: 0 };
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: [],
  });
}
