//! `fad-compile` — the 404AD filter-list compiler.
//!
//! Turns filter lists into everything the extension loads at runtime:
//!
//! ```text
//! lists/*.txt ──▶ canonical IR ──┬──▶ rules/*.json        (Chromium DNR)
//!                                ├──▶ cosmetic.bin        (WASM index, postcard)
//!                                ├──▶ suppression.json    (generichide / elemhide)
//!                                ├──▶ diagnostics.json    (rule ⇄ source, risk)
//!                                └──▶ build-report.json    (budgets, stats)
//! ```
//!
//! Compilation is deterministic: `fad-compile verify` proves it by compiling
//! twice and comparing every emitted byte.

use anyhow::{bail, Context, Result};
use fad_dnr::pack::{pack, Packed};
use fad_dnr::{lower, Lowered};
use fad_filter::matcher::{match_priority, MatchEngine, MatchRequest};
use fad_filter::parse::ListSource;
use fad_filter::{risk, Compiled, ResourceTypes};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const COMPILER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// List manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ListManifest {
    lists: Vec<ListEntry>,
}

#[derive(Debug, Deserialize, Clone)]
struct ListEntry {
    id: String,
    file: String,
    /// Ruleset this list's network rules land in.
    category: String,
    title: String,
    /// Whether the ruleset ships enabled.
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// Emitted artifacts
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleDiagnostic {
    ir_id: u32,
    raw: String,
    list: String,
    line: u32,
    priority: u32,
    shadow: bool,
    risk_score: u8,
    risk_band: risk::RiskBand,
    risk_factors: Vec<risk::RiskFactor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    build_id: String,
    compiler_version: String,
    /// DNR rule id -> provenance and risk.
    network: BTreeMap<u32, RuleDiagnostic>,
    /// Cosmetic IR id -> provenance and risk.
    cosmetic: BTreeMap<u32, RuleDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildReport {
    build_id: String,
    compiler_version: String,
    lists: Vec<ListReport>,
    parsed: ParseReport,
    dedup: DedupReport,
    optimize: OptimizeReport,
    dnr: DnrReport,
    cosmetic: CosmeticReport,
    budgets: Budgets,
    unsupported: Vec<fad_dnr::Unsupported>,
    errors: Vec<ParseErrorReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListReport {
    id: String,
    title: String,
    category: String,
    enabled: bool,
    bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseReport {
    network: usize,
    cosmetic: usize,
    ignored: u32,
    errors: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DedupReport {
    network_removed: usize,
    cosmetic_removed: usize,
    badfiltered: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OptimizeReport {
    merged_by_domain: usize,
    dropped_scope_subsumed: usize,
    dropped_pattern_subsumed: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DnrReport {
    rules: usize,
    enabled_rules: usize,
    regex_rules: usize,
    shadow_rules: usize,
    rulesets: Vec<fad_dnr::pack::RuleResource>,
    per_category: BTreeMap<String, usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CosmeticReport {
    generic_selectors: usize,
    hosts: usize,
    entities: usize,
    scriptlets: usize,
    procedural: usize,
    index_bytes_postcard: usize,
    index_bytes_json: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Budgets {
    static_rules_used: usize,
    static_rules_limit: usize,
    regex_rules_used: usize,
    regex_rules_limit: usize,
    enabled_rulesets_used: usize,
    enabled_rulesets_limit: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParseErrorReport {
    list: String,
    line: u32,
    raw: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("help");
    let flags = parse_flags(&args[args.len().min(1)..]);

    let lists_dir = PathBuf::from(flags.get("lists").map(String::as_str).unwrap_or("lists"));

    match command {
        "build" => {
            let out = PathBuf::from(
                flags
                    .get("out")
                    .map(String::as_str)
                    .unwrap_or("packages/extension/public"),
            );
            let artifacts = build(&lists_dir)?;
            write_artifacts(&out, &artifacts)?;
            print_summary(&artifacts.report);
            Ok(())
        }
        "verify" => {
            let a = build(&lists_dir)?;
            let b = build(&lists_dir)?;
            let differences = diff_artifacts(&a, &b);
            if differences.is_empty() {
                println!(
                    "deterministic: two independent compiles agree on all {} artifacts (build {})",
                    a.files.len(),
                    a.report.build_id
                );
                Ok(())
            } else {
                for d in &differences {
                    eprintln!("non-deterministic artifact: {d}");
                }
                bail!(
                    "{} artifact(s) differed between compiles",
                    differences.len()
                )
            }
        }
        "explain" => {
            let url = flags.get("url").context("--url is required")?;
            let initiator = flags.get("initiator").map(String::as_str).unwrap_or(url);
            let ty = flags.get("type").map(String::as_str).unwrap_or("script");
            explain(&lists_dir, url, initiator, ty)
        }
        _ => {
            println!(
                "fad-compile {COMPILER_VERSION}\n\n\
                 USAGE:\n  \
                 fad-compile build   [--lists DIR] [--out DIR]   compile lists into extension artifacts\n  \
                 fad-compile verify  [--lists DIR]               prove compilation is deterministic\n  \
                 fad-compile explain --url URL [--initiator URL] [--type TYPE]\n"
            );
            Ok(())
        }
    }
}

fn parse_flags(args: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            let value = args.get(i + 1).filter(|v| !v.starts_with("--")).cloned();
            match value {
                Some(v) => {
                    out.insert(name.to_string(), v);
                    i += 2;
                }
                None => {
                    out.insert(name.to_string(), "true".to_string());
                    i += 1;
                }
            }
        } else {
            i += 1;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

struct Artifacts {
    /// Relative path -> file bytes. Everything the build emits.
    files: BTreeMap<String, Vec<u8>>,
    report: BuildReport,
}

fn build(lists_dir: &Path) -> Result<Artifacts> {
    let manifest_path = lists_dir.join("manifest.json");
    let manifest: ListManifest = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .with_context(|| format!("reading {}", manifest_path.display()))?,
    )
    .with_context(|| format!("parsing {}", manifest_path.display()))?;

    // Sorting by id makes the compile independent of manifest ordering.
    let mut entries = manifest.lists.clone();
    entries.sort_by(|a, b| a.id.cmp(&b.id));

    let mut texts: Vec<(ListEntry, String)> = Vec::new();
    for entry in &entries {
        let path = lists_dir.join(&entry.file);
        let text = fs::read_to_string(&path)
            .with_context(|| format!("reading list {}", path.display()))?;
        texts.push((entry.clone(), text));
    }

    let sources: Vec<ListSource<'_>> = texts
        .iter()
        .map(|(e, t)| ListSource { id: &e.id, text: t })
        .collect();
    let compiled: Compiled = fad_filter::compile(&sources);

    let build_id = build_id(&compiled, &texts);

    // --- network: lower to DNR and pack into rulesets -----------------------
    let lowered: Lowered = lower(&compiled.network);
    let ir_category: BTreeMap<u32, String> = compiled
        .network
        .iter()
        .map(|r| {
            let category = entries
                .iter()
                .find(|e| e.id == r.source.list)
                .map(|e| e.category.clone())
                .unwrap_or_else(|| "ads".to_string());
            // Shadow rules always live in their own ruleset so they can be
            // toggled independently of the rules they are candidates for.
            (
                r.id,
                if r.shadow {
                    "shadow".to_string()
                } else {
                    category
                },
            )
        })
        .collect();

    let ir_by_dnr: BTreeMap<u32, u32> = lowered.id_map.iter().copied().collect();
    let categorised: Vec<(fad_dnr::DnrRule, String)> = lowered
        .rules
        .iter()
        .map(|r| {
            let ir_id = ir_by_dnr.get(&r.id).copied().unwrap_or_default();
            let cat = ir_category
                .get(&ir_id)
                .cloned()
                .unwrap_or_else(|| "ads".into());
            (r.clone(), cat)
        })
        .collect();

    let mut enabled: BTreeMap<String, bool> = entries
        .iter()
        .map(|e| (e.category.clone(), e.enabled))
        .collect();
    // Shadow rules are inert allows; shipping them enabled is the whole point.
    enabled.insert("shadow".to_string(), true);

    let packed: Packed = pack(categorised, &enabled, "rules")?;

    // --- cosmetic: build and serialize the runtime index ---------------------
    let cosmetic_index = fad_filter::CosmeticIndex::build(&compiled.cosmetic, build_id.clone());
    let cosmetic_bin = postcard::to_allocvec(&cosmetic_index)
        .context("serializing the cosmetic index with postcard")?;
    let cosmetic_json = serde_json::to_vec_pretty(&cosmetic_index)?;

    // --- diagnostics ---------------------------------------------------------
    let ir_by_id: BTreeMap<u32, &fad_filter::NetworkRule> =
        compiled.network.iter().map(|r| (r.id, r)).collect();

    let mut diagnostics = Diagnostics {
        build_id: build_id.clone(),
        compiler_version: COMPILER_VERSION.to_string(),
        network: BTreeMap::new(),
        cosmetic: BTreeMap::new(),
    };
    for (dnr_id, ir_id) in &lowered.id_map {
        let Some(rule) = ir_by_id.get(ir_id) else {
            continue;
        };
        let assessment = risk::score_network(rule);
        diagnostics.network.insert(
            *dnr_id,
            RuleDiagnostic {
                ir_id: *ir_id,
                raw: rule.source.raw.clone(),
                list: rule.source.list.clone(),
                line: rule.source.line,
                priority: match_priority(rule),
                shadow: rule.shadow,
                risk_score: assessment.score,
                risk_band: assessment.band,
                risk_factors: assessment.factors,
            },
        );
    }
    for rule in &compiled.cosmetic {
        let assessment = risk::score_cosmetic(rule);
        diagnostics.cosmetic.insert(
            rule.id,
            RuleDiagnostic {
                ir_id: rule.id,
                raw: rule.source.raw.clone(),
                list: rule.source.list.clone(),
                line: rule.source.line,
                priority: 0,
                shadow: rule.shadow,
                risk_score: assessment.score,
                risk_band: assessment.band,
                risk_factors: assessment.factors,
            },
        );
    }

    // --- report --------------------------------------------------------------
    let report = BuildReport {
        build_id: build_id.clone(),
        compiler_version: COMPILER_VERSION.to_string(),
        lists: texts
            .iter()
            .map(|(e, t)| ListReport {
                id: e.id.clone(),
                title: e.title.clone(),
                category: e.category.clone(),
                enabled: e.enabled,
                bytes: t.len(),
            })
            .collect(),
        parsed: ParseReport {
            network: compiled.network.len(),
            cosmetic: compiled.cosmetic.len(),
            ignored: compiled.ignored,
            errors: compiled.errors.len(),
        },
        dedup: DedupReport {
            network_removed: compiled.dedup.network_removed(),
            cosmetic_removed: compiled.dedup.cosmetic_removed(),
            badfiltered: compiled.dedup.badfiltered,
        },
        optimize: OptimizeReport {
            merged_by_domain: compiled.optimize.merged_by_domain,
            dropped_scope_subsumed: compiled.optimize.dropped_scope_subsumed,
            dropped_pattern_subsumed: compiled.optimize.dropped_pattern_subsumed,
        },
        dnr: DnrReport {
            rules: packed.stats.total_rules,
            enabled_rules: packed.stats.enabled_rules,
            regex_rules: packed.stats.regex_rules,
            shadow_rules: compiled.network.iter().filter(|r| r.shadow).count(),
            rulesets: packed.rule_resources(),
            per_category: packed.stats.per_category.clone(),
        },
        cosmetic: CosmeticReport {
            generic_selectors: cosmetic_index.generic_count(),
            hosts: cosmetic_index.hosts.len(),
            entities: cosmetic_index.entities.len(),
            scriptlets: cosmetic_index.scriptlets.len(),
            procedural: cosmetic_index.procedural.len(),
            index_bytes_postcard: cosmetic_bin.len(),
            index_bytes_json: cosmetic_json.len(),
        },
        budgets: Budgets {
            static_rules_used: packed.stats.enabled_rules,
            static_rules_limit: fad_dnr::limits::STATIC_RULES,
            regex_rules_used: packed.stats.regex_rules,
            regex_rules_limit: fad_dnr::limits::REGEX_RULES,
            enabled_rulesets_used: packed.stats.enabled_ruleset_count,
            enabled_rulesets_limit: fad_dnr::limits::ENABLED_RULESETS,
        },
        unsupported: lowered.unsupported.clone(),
        errors: compiled
            .errors
            .iter()
            .map(|(list, line, raw, e)| ParseErrorReport {
                list: list.clone(),
                line: *line,
                raw: raw.clone(),
                error: e.to_string(),
            })
            .collect(),
    };

    // --- assemble files ------------------------------------------------------
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for ruleset in &packed.rulesets {
        files.insert(
            ruleset.path.clone(),
            serde_json::to_vec_pretty(&ruleset.rules)?,
        );
    }
    // The canonical IR ships too, so the diagnostics engine can answer
    // "why was this blocked?" offline from the same rules DNR enforces.
    let network_ir = postcard::to_allocvec(&compiled.network)
        .context("serializing the network IR with postcard")?;
    files.insert("generated/network-ir.bin".into(), network_ir);
    files.insert("generated/cosmetic.bin".into(), cosmetic_bin);
    files.insert("generated/cosmetic.json".into(), cosmetic_json);
    files.insert(
        "generated/suppression.json".into(),
        serde_json::to_vec_pretty(&lowered.suppressions)?,
    );
    files.insert(
        "generated/diagnostics.json".into(),
        serde_json::to_vec_pretty(&diagnostics)?,
    );
    files.insert(
        "generated/build-report.json".into(),
        serde_json::to_vec_pretty(&report)?,
    );
    files.insert(
        "generated/rulesets.json".into(),
        serde_json::to_vec_pretty(&packed.rule_resources())?,
    );

    Ok(Artifacts { files, report })
}

/// A 128-bit FNV-1a fingerprint of the compiler version plus every input byte
/// and every canonical rule key.
///
/// ponytail: FNV, not SHA-256. This is a change detector for caching and for
/// pinning diagnostics to a build, never a security boundary, so a cryptographic
/// digest would buy nothing. Upgrade path: swap in `sha2` if the build id ever
/// needs to be tamper-evident.
fn build_id(compiled: &Compiled, texts: &[(ListEntry, String)]) -> String {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;

    let mut hash = OFFSET;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            hash ^= *b as u128;
            hash = hash.wrapping_mul(PRIME);
        }
    };
    eat(COMPILER_VERSION.as_bytes());
    for (entry, text) in texts {
        eat(entry.id.as_bytes());
        eat(text.as_bytes());
    }
    for rule in &compiled.network {
        eat(rule.canonical_key().as_bytes());
    }
    for rule in &compiled.cosmetic {
        eat(rule.canonical_key().as_bytes());
    }
    format!("{hash:032x}")
}

fn write_artifacts(out: &Path, artifacts: &Artifacts) -> Result<()> {
    // Clear previously generated output so a removed rule cannot linger.
    for dir in ["rules", "generated"] {
        let path = out.join(dir);
        if path.exists() {
            fs::remove_dir_all(&path).with_context(|| format!("clearing {}", path.display()))?;
        }
    }
    for (rel, bytes) in &artifacts.files {
        let path = out.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes).with_context(|| format!("writing {}", path.display()))?;
    }
    Ok(())
}

fn diff_artifacts(a: &Artifacts, b: &Artifacts) -> Vec<String> {
    let mut out = Vec::new();
    for (name, bytes) in &a.files {
        match b.files.get(name) {
            Some(other) if other == bytes => {}
            Some(_) => out.push(format!("{name} (content differs)")),
            None => out.push(format!("{name} (missing from second compile)")),
        }
    }
    for name in b.files.keys() {
        if !a.files.contains_key(name) {
            out.push(format!("{name} (only in second compile)"));
        }
    }
    out
}

fn print_summary(r: &BuildReport) {
    println!(
        "404AD compile {} (compiler {})",
        r.build_id, r.compiler_version
    );
    println!(
        "  lists            {:>7}  ({} bytes)",
        r.lists.len(),
        r.lists.iter().map(|l| l.bytes).sum::<usize>()
    );
    println!(
        "  parsed           {:>7} network, {} cosmetic, {} errors",
        r.parsed.network, r.parsed.cosmetic, r.parsed.errors
    );
    println!(
        "  dedup removed    {:>7} network, {} cosmetic, {} badfiltered",
        r.dedup.network_removed, r.dedup.cosmetic_removed, r.dedup.badfiltered
    );
    println!(
        "  optimized        {:>7} merged, {} scope-subsumed, {} pattern-subsumed",
        r.optimize.merged_by_domain,
        r.optimize.dropped_scope_subsumed,
        r.optimize.dropped_pattern_subsumed
    );
    println!(
        "  DNR rules        {:>7} total, {} enabled, {} regex, {} shadow",
        r.dnr.rules, r.dnr.enabled_rules, r.dnr.regex_rules, r.dnr.shadow_rules
    );
    for rs in &r.dnr.rulesets {
        println!(
            "      {:<24} {}",
            rs.id,
            if rs.enabled { "enabled" } else { "disabled" }
        );
    }
    println!(
        "  cosmetic index   {:>7} generic, {} hosts, {} entities, {} scriptlets",
        r.cosmetic.generic_selectors, r.cosmetic.hosts, r.cosmetic.entities, r.cosmetic.scriptlets
    );
    println!(
        "      postcard {} bytes vs json {} bytes ({:.0}% smaller)",
        r.cosmetic.index_bytes_postcard,
        r.cosmetic.index_bytes_json,
        100.0
            - (r.cosmetic.index_bytes_postcard as f64 / r.cosmetic.index_bytes_json.max(1) as f64)
                * 100.0
    );
    println!(
        "  budgets          {}/{} static rules, {}/{} regex, {}/{} enabled rulesets",
        r.budgets.static_rules_used,
        r.budgets.static_rules_limit,
        r.budgets.regex_rules_used,
        r.budgets.regex_rules_limit,
        r.budgets.enabled_rulesets_used,
        r.budgets.enabled_rulesets_limit
    );
    if !r.unsupported.is_empty() {
        println!(
            "  unsupported      {:>7} rule(s) the MV3 backend cannot express:",
            r.unsupported.len()
        );
        for u in r.unsupported.iter().take(10) {
            println!("      {}:{}  {}  — {}", u.list, u.line, u.raw, u.reason);
        }
    }
    if !r.errors.is_empty() {
        println!("  parse errors     {:>7}:", r.errors.len());
        for e in r.errors.iter().take(10) {
            println!("      {}:{}  {}  — {}", e.list, e.line, e.raw, e.error);
        }
    }
}

fn explain(lists_dir: &Path, url: &str, initiator: &str, ty: &str) -> Result<()> {
    let manifest: ListManifest =
        serde_json::from_str(&fs::read_to_string(lists_dir.join("manifest.json"))?)?;
    let mut texts = Vec::new();
    for entry in &manifest.lists {
        texts.push((
            entry.id.clone(),
            fs::read_to_string(lists_dir.join(&entry.file))?,
        ));
    }
    let sources: Vec<ListSource<'_>> = texts
        .iter()
        .map(|(id, t)| ListSource { id, text: t })
        .collect();
    let compiled = fad_filter::compile(&sources);
    let engine = MatchEngine::new(compiled.network.clone())?;

    let resource =
        resource_from_name(ty).with_context(|| format!("unknown resource type `{ty}`"))?;
    let request = MatchRequest::from_urls(url, initiator, resource);
    let decision = engine.evaluate(&request);

    println!("request  {url}");
    println!("document {initiator}");
    println!(
        "type     {ty}  ({})",
        if request.third_party {
            "third-party"
        } else {
            "first-party"
        }
    );
    println!("result   {:?}", decision.action);
    if decision.matched.is_empty() {
        println!("\nno rule matched this request");
        return Ok(());
    }
    println!("\nmatching rules, highest priority first:");
    for m in &decision.matched {
        let winner = decision
            .winner
            .as_ref()
            .is_some_and(|w| w.rule_id == m.rule_id);
        let assessment = engine.rule(m.rule_id).map(risk::score_network);
        println!(
            "  {} prio {:>4}  {:?}{}  {}:{}  {}",
            if winner { "▶" } else { " " },
            m.priority,
            m.action,
            if m.shadow {
                " (shadow: observed, not enforced)"
            } else {
                ""
            },
            m.list,
            m.line,
            m.raw
        );
        if let Some(a) = assessment {
            // The arithmetic is printed, not just the total: the score is meant
            // to be checked by hand, not trusted on faith.
            let terms: Vec<String> = a
                .factors
                .iter()
                .map(|f| format!("{:+} {}", f.delta, f.reason))
                .collect();
            println!(
                "      breakage risk {} ({:?}) = {}",
                a.score,
                a.band,
                terms.join(", ")
            );
        }
    }
    Ok(())
}

fn resource_from_name(name: &str) -> Option<ResourceTypes> {
    Some(match name {
        "main_frame" | "document" => ResourceTypes::MAIN_FRAME,
        "sub_frame" | "subdocument" => ResourceTypes::SUB_FRAME,
        "stylesheet" => ResourceTypes::STYLESHEET,
        "script" => ResourceTypes::SCRIPT,
        "image" => ResourceTypes::IMAGE,
        "font" => ResourceTypes::FONT,
        "object" => ResourceTypes::OBJECT,
        "xmlhttprequest" | "xhr" => ResourceTypes::XHR,
        "ping" => ResourceTypes::PING,
        "media" => ResourceTypes::MEDIA,
        "websocket" => ResourceTypes::WEBSOCKET,
        "other" => ResourceTypes::OTHER,
        _ => return None,
    })
}
