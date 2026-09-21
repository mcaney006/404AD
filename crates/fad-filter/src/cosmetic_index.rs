//! The packed cosmetic index.
//!
//! This structure is the compiler's output *and* the WASM runtime's input, so it
//! lives in the shared crate and is serialized with both `serde_json` (for the
//! human-readable debug artifact) and `postcard` (for the shipped binary).
//!
//! Two lookups matter at runtime, and the index exists to make both O(small):
//!
//! * [`CosmeticIndex::lookup_host`] — host-specific rules, found by suffix
//!   decomposition rather than by scanning every rule's domain list.
//! * [`CosmeticIndex::select_generic`] — given the class and id tokens actually
//!   present in a document, return only the generic selectors that can possibly
//!   match. A full list ships ~100k generic selectors; a typical page yields a
//!   few hundred tokens, and this reduces the injected stylesheet accordingly.

use crate::ir::{CosmeticKind, CosmeticRule, Procedural};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// A procedural rule, kept whole because it must be evaluated in JS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProceduralEntry {
    pub rule_id: u32,
    /// Plain-CSS prefix used to gather candidate elements. `None` means `*`.
    pub prefix: Option<String>,
    pub ops: Vec<Procedural>,
    pub shadow: bool,
}

/// A scriptlet invocation: name plus already-split arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScriptletEntry {
    pub rule_id: u32,
    pub name: String,
    pub args: Vec<String>,
    pub shadow: bool,
}

/// Per-host rule references. All vectors hold ids into the shared pools.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostBucket {
    #[serde(default)]
    pub hide: Vec<u32>,
    /// Selectors cancelled on this host, whether they came from a `#@#` rule or
    /// from a `~host` exclusion on a generic rule. Both mean the same thing.
    #[serde(default)]
    pub unhide: Vec<u32>,
    #[serde(default)]
    pub styles: Vec<u32>,
    #[serde(default)]
    pub scriptlets: Vec<u32>,
    #[serde(default)]
    pub unscriptlets: Vec<u32>,
    #[serde(default)]
    pub procedural: Vec<u32>,
}

impl HostBucket {
    fn is_empty(&self) -> bool {
        self.hide.is_empty()
            && self.unhide.is_empty()
            && self.styles.is_empty()
            && self.scriptlets.is_empty()
            && self.unscriptlets.is_empty()
            && self.procedural.is_empty()
    }
    fn sort_dedup(&mut self) {
        for v in [
            &mut self.hide,
            &mut self.unhide,
            &mut self.styles,
            &mut self.scriptlets,
            &mut self.unscriptlets,
            &mut self.procedural,
        ] {
            v.sort_unstable();
            v.dedup();
        }
    }
}

/// The compiled cosmetic index.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CosmeticIndex {
    /// Content hash of the inputs. Changes iff the compiled output changes.
    pub build_id: String,
    /// Shared selector pool. Every `hide`/`unhide` id points here.
    pub selectors: Vec<String>,
    /// Shared style-declaration pool (`selector { decls }`).
    pub styles: Vec<String>,
    pub scriptlets: Vec<ScriptletEntry>,
    pub procedural: Vec<ProceduralEntry>,
    /// Generic selector ids grouped by their anchor token (`.cls` or `#id`).
    pub generic_by_token: BTreeMap<String, Vec<u32>>,
    /// Generic selectors with no class/id anchor. Always injected.
    pub generic_unanchored: Vec<u32>,
    /// Exact hostnames.
    pub hosts: BTreeMap<String, HostBucket>,
    /// Entity scopes, keyed without the `.*` suffix (`google` for `google.*`).
    pub entities: BTreeMap<String, HostBucket>,
    /// Selector id -> originating rule id, for the diagnostics panel.
    pub selector_origin: BTreeMap<u32, u32>,
}

/// The rules that apply to one document.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostResult {
    pub hide: Vec<String>,
    pub styles: Vec<String>,
    pub scriptlets: Vec<ScriptletEntry>,
    pub procedural: Vec<ProceduralEntry>,
    /// Selector ids cancelled on this host, needed to filter generics too.
    pub unhide_ids: Vec<u32>,
}

impl CosmeticIndex {
    /// Build the index from normalized cosmetic rules.
    pub fn build(rules: &[CosmeticRule], build_id: impl Into<String>) -> Self {
        let mut idx = CosmeticIndex {
            build_id: build_id.into(),
            ..Default::default()
        };
        let mut selector_ids: BTreeMap<String, u32> = BTreeMap::new();
        let mut style_ids: BTreeMap<String, u32> = BTreeMap::new();

        let intern = |pool: &mut Vec<String>, map: &mut BTreeMap<String, u32>, s: &str| -> u32 {
            if let Some(id) = map.get(s) {
                return *id;
            }
            let id = pool.len() as u32;
            pool.push(s.to_string());
            map.insert(s.to_string(), id);
            id
        };

        for rule in rules {
            match rule.kind {
                CosmeticKind::Hide | CosmeticKind::Unhide => {
                    let key = rule.css_prefix.as_deref().unwrap_or(&rule.payload);
                    let is_procedural = !rule.procedural.is_empty();

                    let sel_id = if is_procedural {
                        let pid = idx.procedural.len() as u32;
                        idx.procedural.push(ProceduralEntry {
                            rule_id: rule.id,
                            prefix: rule.css_prefix.clone(),
                            ops: rule.procedural.clone(),
                            shadow: rule.shadow,
                        });
                        // Procedural rules are host-scoped only; a generic
                        // procedural rule would run on every page load.
                        for host in Self::scope_keys(rule) {
                            idx.bucket_mut(&host).procedural.push(pid);
                        }
                        continue;
                    } else {
                        intern(&mut idx.selectors, &mut selector_ids, key)
                    };
                    idx.selector_origin.insert(sel_id, rule.id);

                    if rule.kind == CosmeticKind::Unhide {
                        for host in Self::scope_keys(rule) {
                            idx.bucket_mut(&host).unhide.push(sel_id);
                        }
                        continue;
                    }

                    if rule.is_generic() {
                        match rule.anchor_token() {
                            Some(tok) => idx.generic_by_token.entry(tok).or_default().push(sel_id),
                            None => idx.generic_unanchored.push(sel_id),
                        }
                        // `~host` on a generic rule means "hide everywhere but here".
                        for host in Self::exclusion_keys(rule) {
                            idx.bucket_mut(&host).unhide.push(sel_id);
                        }
                    } else {
                        for host in Self::scope_keys(rule) {
                            idx.bucket_mut(&host).hide.push(sel_id);
                        }
                        for host in Self::exclusion_keys(rule) {
                            idx.bucket_mut(&host).unhide.push(sel_id);
                        }
                    }
                }
                CosmeticKind::Style => {
                    let sid = intern(&mut idx.styles, &mut style_ids, &rule.payload);
                    for host in Self::scope_keys(rule) {
                        idx.bucket_mut(&host).styles.push(sid);
                    }
                }
                CosmeticKind::Scriptlet | CosmeticKind::UnScriptlet => {
                    let (name, args) = split_scriptlet(&rule.payload);
                    let sid = idx.scriptlets.len() as u32;
                    idx.scriptlets.push(ScriptletEntry {
                        rule_id: rule.id,
                        name,
                        args,
                        shadow: rule.shadow,
                    });
                    for host in Self::scope_keys(rule) {
                        if rule.kind == CosmeticKind::Scriptlet {
                            idx.bucket_mut(&host).scriptlets.push(sid);
                        } else {
                            idx.bucket_mut(&host).unscriptlets.push(sid);
                        }
                    }
                }
            }
        }

        for v in idx.generic_by_token.values_mut() {
            v.sort_unstable();
            v.dedup();
        }
        idx.generic_unanchored.sort_unstable();
        idx.generic_unanchored.dedup();
        for b in idx.hosts.values_mut().chain(idx.entities.values_mut()) {
            b.sort_dedup();
        }
        idx.hosts.retain(|_, b| !b.is_empty());
        idx.entities.retain(|_, b| !b.is_empty());
        idx
    }

    /// Scope keys are prefixed so `hosts` and `entities` can share a writer.
    fn scope_keys(rule: &CosmeticRule) -> Vec<String> {
        if rule.domains.is_empty() {
            return Vec::new();
        }
        rule.domains.iter().cloned().collect()
    }

    fn exclusion_keys(rule: &CosmeticRule) -> Vec<String> {
        rule.excluded_domains.iter().cloned().collect()
    }

    fn bucket_mut(&mut self, key: &str) -> &mut HostBucket {
        match key.strip_suffix(".*") {
            Some(prefix) => self.entities.entry(prefix.to_string()).or_default(),
            None => self.hosts.entry(key.to_string()).or_default(),
        }
    }

    /// Collect every rule that applies to `hostname`.
    pub fn lookup_host(&self, hostname: &str) -> HostResult {
        let mut hide_ids: BTreeSet<u32> = BTreeSet::new();
        let mut unhide_ids: BTreeSet<u32> = BTreeSet::new();
        let mut style_ids: BTreeSet<u32> = BTreeSet::new();
        let mut scriptlet_ids: BTreeSet<u32> = BTreeSet::new();
        let mut unscriptlet_ids: BTreeSet<u32> = BTreeSet::new();
        let mut proc_ids: BTreeSet<u32> = BTreeSet::new();

        let mut absorb = |b: &HostBucket| {
            hide_ids.extend(&b.hide);
            unhide_ids.extend(&b.unhide);
            style_ids.extend(&b.styles);
            scriptlet_ids.extend(&b.scriptlets);
            unscriptlet_ids.extend(&b.unscriptlets);
            proc_ids.extend(&b.procedural);
        };

        for suffix in crate::index::host_suffixes(hostname) {
            if let Some(b) = self.hosts.get(suffix) {
                absorb(b);
            }
        }
        if let Some(b) = self.entities.get(crate::index::entity_label(hostname)) {
            absorb(b);
        }

        // A cancelled scriptlet must not run, so subtract by name+args.
        let cancelled: BTreeSet<(&str, &[String])> = unscriptlet_ids
            .iter()
            .filter_map(|id| self.scriptlets.get(*id as usize))
            .map(|s| (s.name.as_str(), s.args.as_slice()))
            .collect();

        HostResult {
            hide: hide_ids
                .iter()
                .filter(|id| !unhide_ids.contains(id))
                .filter_map(|id| self.selectors.get(*id as usize).cloned())
                .collect(),
            styles: style_ids
                .iter()
                .filter_map(|id| self.styles.get(*id as usize).cloned())
                .collect(),
            scriptlets: scriptlet_ids
                .iter()
                .filter_map(|id| self.scriptlets.get(*id as usize))
                .filter(|s| !cancelled.contains(&(s.name.as_str(), s.args.as_slice())))
                .cloned()
                .collect(),
            procedural: proc_ids
                .iter()
                .filter_map(|id| self.procedural.get(*id as usize).cloned())
                .collect(),
            unhide_ids: unhide_ids.into_iter().collect(),
        }
    }

    /// Generic selectors whose anchor token is present in the document.
    ///
    /// `tokens` are `.class` / `#id` strings harvested from the live DOM.
    /// `unhide_ids` comes from [`HostResult`] so host exceptions also cancel
    /// generic rules.
    pub fn select_generic(&self, tokens: &[String], unhide_ids: &[u32]) -> Vec<String> {
        let cancelled: BTreeSet<u32> = unhide_ids.iter().copied().collect();
        let mut ids: BTreeSet<u32> = self
            .generic_unanchored
            .iter()
            .copied()
            .filter(|id| !cancelled.contains(id))
            .collect();

        for token in tokens {
            if let Some(hits) = self.generic_by_token.get(token) {
                ids.extend(hits.iter().copied().filter(|id| !cancelled.contains(id)));
            }
        }
        ids.iter()
            .filter_map(|id| self.selectors.get(*id as usize).cloned())
            .collect()
    }

    pub fn generic_count(&self) -> usize {
        self.generic_by_token.values().map(Vec::len).sum::<usize>() + self.generic_unanchored.len()
    }
}

/// `set-constant, adsEnabled, false` -> (`set-constant`, [`adsEnabled`, `false`]).
///
/// A `\,` escape lets an argument contain a literal comma.
pub fn split_scriptlet(payload: &str) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    for c in payload.chars() {
        match c {
            '\\' if !escaped => escaped = true,
            ',' if !escaped => {
                parts.push(cur.trim().to_string());
                cur = String::new();
            }
            _ => {
                cur.push(c);
                escaped = false;
            }
        }
    }
    parts.push(cur.trim().to_string());
    let name = if parts.is_empty() {
        String::new()
    } else {
        parts.remove(0)
    };
    (name, parts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedup::dedup;
    use crate::optimize::assign_cosmetic_ids;
    use crate::parse::{parse_list, ListSource, ParseOutput};

    fn index(text: &str) -> CosmeticIndex {
        let mut out = ParseOutput::default();
        parse_list(&ListSource { id: "t", text }, &mut out);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        let (_, cos, _) = dedup(out.network, out.cosmetic, &out.badfilters);
        CosmeticIndex::build(&assign_cosmetic_ids(cos), "test")
    }

    #[test]
    fn host_rules_reach_subdomains() {
        let idx = index("example.com##.promo");
        assert_eq!(
            idx.lookup_host("www.example.com").hide,
            vec![".promo".to_string()]
        );
        assert!(idx.lookup_host("example.org").hide.is_empty());
    }

    #[test]
    fn entity_rules_match_any_tld() {
        let idx = index("google.*##.ad-slot");
        assert_eq!(
            idx.lookup_host("google.co.uk").hide,
            vec![".ad-slot".to_string()]
        );
        assert_eq!(
            idx.lookup_host("www.google.de").hide,
            vec![".ad-slot".to_string()]
        );
        assert!(idx.lookup_host("notgoogle.com").hide.is_empty());
    }

    #[test]
    fn unhide_cancels_a_specific_rule() {
        let idx = index("example.com##.promo\nexample.com#@#.promo");
        assert!(idx.lookup_host("example.com").hide.is_empty());
    }

    #[test]
    fn generic_selectors_are_gated_on_observed_tokens() {
        let idx = index("##.ad-banner\n##.sponsored-post\n##.newsletter-modal");
        assert_eq!(idx.generic_count(), 3);

        let present = vec![".ad-banner".to_string(), ".unrelated".to_string()];
        let picked = idx.select_generic(&present, &[]);
        assert_eq!(picked, vec![".ad-banner".to_string()]);
    }

    #[test]
    fn host_exception_also_cancels_a_generic_rule() {
        let idx = index("##.ad-banner\nexample.com#@#.ad-banner");
        let host = idx.lookup_host("example.com");
        let picked = idx.select_generic(&[".ad-banner".to_string()], &host.unhide_ids);
        assert!(
            picked.is_empty(),
            "generic rule should be cancelled on example.com"
        );

        let other = idx.lookup_host("other.com");
        let picked = idx.select_generic(&[".ad-banner".to_string()], &other.unhide_ids);
        assert_eq!(picked, vec![".ad-banner".to_string()]);
    }

    #[test]
    fn tilde_exclusion_behaves_like_an_exception() {
        let idx = index("~example.com##.ad-banner");
        let host = idx.lookup_host("example.com");
        assert!(idx
            .select_generic(&[".ad-banner".into()], &host.unhide_ids)
            .is_empty());
    }

    #[test]
    fn scriptlets_split_name_and_args() {
        let idx = index("example.com##+js(set-constant, app.ads, false)");
        let s = &idx.lookup_host("example.com").scriptlets;
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "set-constant");
        assert_eq!(s[0].args, vec!["app.ads".to_string(), "false".to_string()]);
    }

    #[test]
    fn unscriptlet_cancels_by_name_and_args() {
        let idx = index(
            "example.com##+js(set-constant, app.ads, false)\nexample.com#@#+js(set-constant, app.ads, false)",
        );
        assert!(idx.lookup_host("example.com").scriptlets.is_empty());
    }

    #[test]
    fn procedural_rules_are_kept_whole_for_js_evaluation() {
        let idx = index("example.com##div:has-text(Sponsored)");
        let p = &idx.lookup_host("example.com").procedural;
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].prefix.as_deref(), Some("div"));
    }

    #[test]
    fn index_survives_a_postcard_round_trip() {
        let idx = index("example.com##.promo\n##.ad-banner\nexample.com##+js(nowebrtc)");
        let bytes = postcard::to_allocvec(&idx).unwrap();
        let back: CosmeticIndex = postcard::from_bytes(&bytes).unwrap();
        assert_eq!(idx, back);
    }
}
