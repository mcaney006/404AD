import { loadSettings, saveSettings } from "./settings";

/**
 * Static ruleset management.
 *
 * The compiler decides which rulesets exist and which ship enabled; this module
 * reconciles that declaration with the user's choices and with what Chromium
 * currently has enabled.
 */

export interface RuleResource {
  id: string;
  enabled: boolean;
  path: string;
}

let manifestRulesets: RuleResource[] | null = null;

export async function availableRulesets(): Promise<RuleResource[]> {
  if (manifestRulesets) return manifestRulesets;
  const response = await fetch(chrome.runtime.getURL("generated/rulesets.json"));
  manifestRulesets = (await response.json()) as RuleResource[];
  return manifestRulesets;
}

/**
 * Apply the user's ruleset choices.
 *
 * Chromium rejects the whole call if it names an unknown ruleset id, so the
 * requested sets are intersected with what the manifest actually declares. A
 * stale id left over from an older build must not brick rule loading.
 */
export async function syncRulesets(): Promise<string[]> {
  const [settings, available] = await Promise.all([loadSettings(), availableRulesets()]);
  const known = new Set(available.map((r) => r.id));

  // Fill in defaults for rulesets this profile has never seen.
  const choices: Record<string, boolean> = { ...settings.rulesets };
  let changed = false;
  for (const ruleset of available) {
    if (!(ruleset.id in choices)) {
      choices[ruleset.id] = ruleset.enabled;
      changed = true;
    }
  }
  for (const id of Object.keys(choices)) {
    if (!known.has(id)) {
      delete choices[id];
      changed = true;
    }
  }
  if (changed) await saveSettings({ rulesets: choices });

  const masterOff = !settings.enabled;
  const wanted = new Set(
    masterOff ? [] : available.filter((r) => choices[r.id] ?? r.enabled).map((r) => r.id),
  );

  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = [...wanted].filter((id) => !current.has(id));
  const disableRulesetIds = [...current].filter((id) => !wanted.has(id));

  if (enableRulesetIds.length > 0 || disableRulesetIds.length > 0) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds,
      disableRulesetIds,
    });
  }
  return [...wanted].sort();
}
