//! The 404AD WASM runtime.
//!
//! Three jobs, all of them control-plane. Chromium's `declarativeNetRequest`
//! engine decides every request; nothing here ever sits in a request path.
//!
//! 1. [`CosmeticEngine`] — resolve which cosmetic rules apply to a document,
//!    and narrow ~50k generic selectors down to the handful whose class or id
//!    token actually appears in the page. Doing this in JS means shipping every
//!    selector into the content script and filtering there; doing it here keeps
//!    the index in linear memory and returns only what matches.
//! 2. [`DiagnosticsEngine`] — answer "why was this request blocked?" offline,
//!    from the same IR the DNR rules were lowered from.
//! 3. [`validate_filters`] — parse user-written filters, report syntax errors
//!    with a reason, and score each one for breakage risk before it is applied.

use fad_filter::cosmetic_index::CosmeticIndex;
use fad_filter::ir::{NetworkRule, ParsedLine, ResourceTypes, SourceRef};
use fad_filter::matcher::{MatchEngine, MatchRequest};
use fad_filter::{parse, risk};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Surface a Rust panic as a readable JS error instead of `unreachable`.
#[wasm_bindgen(start)]
pub fn init() {
    std::panic::set_hook(Box::new(|info| {
        web_error(&format!("404AD wasm panic: {info}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn web_error(msg: &str);
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|e| JsValue::from_str(&e.to_string()))
}

// ---------------------------------------------------------------------------
// Cosmetic filtering
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexStats {
    build_id: String,
    generic_selectors: usize,
    distinct_tokens: usize,
    hosts: usize,
    entities: usize,
    scriptlets: usize,
    procedural: usize,
}

#[wasm_bindgen]
pub struct CosmeticEngine {
    index: CosmeticIndex,
}

#[wasm_bindgen]
impl CosmeticEngine {
    /// Load a `cosmetic.bin` produced by `fad-compile build`.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<CosmeticEngine, JsValue> {
        let index: CosmeticIndex = postcard::from_bytes(bytes)
            .map_err(|e| JsValue::from_str(&format!("cosmetic index is corrupt: {e}")))?;
        Ok(CosmeticEngine { index })
    }

    #[wasm_bindgen(js_name = buildId)]
    pub fn build_id(&self) -> String {
        self.index.build_id.clone()
    }

    pub fn stats(&self) -> Result<JsValue, JsValue> {
        to_js(&IndexStats {
            build_id: self.index.build_id.clone(),
            generic_selectors: self.index.generic_count(),
            distinct_tokens: self.index.generic_by_token.len(),
            hosts: self.index.hosts.len(),
            entities: self.index.entities.len(),
            scriptlets: self.index.scriptlets.len(),
            procedural: self.index.procedural.len(),
        })
    }

    /// Host-specific rules: hide selectors, styles, scriptlets and procedural
    /// selectors, with every exception already subtracted.
    #[wasm_bindgen(js_name = lookupHost)]
    pub fn lookup_host(&self, hostname: &str) -> Result<JsValue, JsValue> {
        to_js(&self.index.lookup_host(hostname))
    }

    /// Generic selectors gated on the tokens actually present in the document.
    ///
    /// `tokens` are `.class` / `#id` strings harvested from the live DOM;
    /// `unhide_ids` comes from the `unhideIds` field of [`Self::lookup_host`].
    #[wasm_bindgen(js_name = selectGeneric)]
    pub fn select_generic(&self, tokens: Vec<String>, unhide_ids: Vec<u32>) -> Vec<String> {
        self.index.select_generic(&tokens, &unhide_ids)
    }

    /// One call for the common case: everything a content script needs on load.
    #[wasm_bindgen(js_name = resolveDocument)]
    pub fn resolve_document(
        &self,
        hostname: &str,
        tokens: Vec<String>,
    ) -> Result<JsValue, JsValue> {
        let host = self.index.lookup_host(hostname);
        let generic = self.index.select_generic(&tokens, &host.unhide_ids);

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Resolved {
            specific: Vec<String>,
            generic: Vec<String>,
            styles: Vec<String>,
            scriptlets: Vec<fad_filter::cosmetic_index::ScriptletEntry>,
            procedural: Vec<fad_filter::cosmetic_index::ProceduralEntry>,
            unhide_ids: Vec<u32>,
        }

        to_js(&Resolved {
            specific: host.hide,
            generic,
            styles: host.styles,
            scriptlets: host.scriptlets,
            procedural: host.procedural,
            unhide_ids: host.unhide_ids,
        })
    }
}

// ---------------------------------------------------------------------------
// Request diagnostics
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExplainedRule {
    rule_id: u32,
    priority: u32,
    action: fad_filter::Action,
    shadow: bool,
    raw: String,
    list: String,
    line: u32,
    risk_score: u8,
    risk_band: risk::RiskBand,
    risk_factors: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Explanation {
    action: fad_filter::Action,
    third_party: bool,
    winner: Option<ExplainedRule>,
    matched: Vec<ExplainedRule>,
}

#[wasm_bindgen]
pub struct DiagnosticsEngine {
    engine: MatchEngine,
}

#[wasm_bindgen]
impl DiagnosticsEngine {
    /// Load a `network-ir.bin` produced by `fad-compile build`.
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<DiagnosticsEngine, JsValue> {
        let rules: Vec<NetworkRule> = postcard::from_bytes(bytes)
            .map_err(|e| JsValue::from_str(&format!("network IR is corrupt: {e}")))?;
        let engine = MatchEngine::new(rules)
            .map_err(|e| JsValue::from_str(&format!("index build failed: {e}")))?;
        Ok(DiagnosticsEngine { engine })
    }

    #[wasm_bindgen(js_name = ruleCount)]
    pub fn rule_count(&self) -> usize {
        self.engine.rule_count()
    }

    /// Explain what the rule set does with one request, and why.
    ///
    /// Returns every matching rule, not just the winner: the useful question is
    /// usually "what else nearly matched", especially when a page broke.
    pub fn explain(
        &self,
        url: &str,
        initiator: &str,
        resource_type: &str,
    ) -> Result<JsValue, JsValue> {
        let resource = resource_from_name(resource_type).ok_or_else(|| {
            JsValue::from_str(&format!("unknown resource type `{resource_type}`"))
        })?;
        let request = MatchRequest::from_urls(url, initiator, resource);
        let decision = self.engine.evaluate(&request);

        let describe = |m: &fad_filter::matcher::MatchDetail| -> ExplainedRule {
            let assessment = self
                .engine
                .rule(m.rule_id)
                .map(risk::score_network)
                .unwrap_or(risk::RiskAssessment {
                    score: 0,
                    band: risk::RiskBand::Low,
                    factors: Vec::new(),
                });
            ExplainedRule {
                rule_id: m.rule_id,
                priority: m.priority,
                action: m.action,
                shadow: m.shadow,
                raw: m.raw.clone(),
                list: m.list.clone(),
                line: m.line,
                risk_score: assessment.score,
                risk_band: assessment.band,
                risk_factors: assessment.factors,
            }
        };

        to_js(&Explanation {
            action: decision.action,
            third_party: request.third_party,
            winner: decision.winner.as_ref().map(&describe),
            matched: decision.matched.iter().map(&describe).collect(),
        })
    }
}

fn resource_from_name(name: &str) -> Option<ResourceTypes> {
    Some(match name {
        "main_frame" => ResourceTypes::MAIN_FRAME,
        "sub_frame" => ResourceTypes::SUB_FRAME,
        "stylesheet" => ResourceTypes::STYLESHEET,
        "script" => ResourceTypes::SCRIPT,
        "image" => ResourceTypes::IMAGE,
        "font" => ResourceTypes::FONT,
        "object" => ResourceTypes::OBJECT,
        "xmlhttprequest" => ResourceTypes::XHR,
        "ping" => ResourceTypes::PING,
        "csp_report" => ResourceTypes::CSP_REPORT,
        "media" => ResourceTypes::MEDIA,
        "websocket" => ResourceTypes::WEBSOCKET,
        "webtransport" => ResourceTypes::WEBTRANSPORT,
        "webbundle" => ResourceTypes::WEBBUNDLE,
        "other" => ResourceTypes::OTHER,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// User filter validation
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidatedLine {
    line: u32,
    raw: String,
    /// `network`, `cosmetic`, `comment`, or `error`.
    kind: &'static str,
    error: Option<String>,
    risk_score: u8,
    risk_band: risk::RiskBand,
    risk_factors: Vec<&'static str>,
    /// True when the rule is risky enough that 404AD holds it in shadow mode
    /// until the user explicitly confirms it.
    needs_confirmation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationResult {
    lines: Vec<ValidatedLine>,
    network_rules: usize,
    cosmetic_rules: usize,
    errors: usize,
    needs_confirmation: usize,
}

/// A user filter at or above this score is held in shadow mode until confirmed.
///
/// `High` starts at 55; anything that broad written by hand is far more likely
/// to be a mistake than an intent.
const CONFIRMATION_THRESHOLD: u8 = 55;

/// Parse and score custom filters, one line at a time.
///
/// Nothing is rejected outright. A malformed line is reported with its reason
/// and a dangerous one is flagged, but the user stays in control of both.
#[wasm_bindgen(js_name = validateFilters)]
pub fn validate_filters(text: &str) -> Result<JsValue, JsValue> {
    let mut result = ValidationResult {
        lines: Vec::new(),
        network_rules: 0,
        cosmetic_rules: 0,
        errors: 0,
        needs_confirmation: 0,
    };

    for (idx, raw_line) in text.lines().enumerate() {
        let line_no = idx as u32 + 1;
        let trimmed = raw_line.trim();
        if trimmed.is_empty() || trimmed.starts_with('!') || trimmed.starts_with('[') {
            result.lines.push(ValidatedLine {
                line: line_no,
                raw: trimmed.to_string(),
                kind: "comment",
                error: None,
                risk_score: 0,
                risk_band: risk::RiskBand::Low,
                risk_factors: Vec::new(),
                needs_confirmation: false,
            });
            continue;
        }

        let source = SourceRef {
            list: "user".into(),
            line: line_no,
            raw: trimmed.to_string(),
        };
        match parse::parse_line(trimmed, source, false) {
            Ok(ParsedLine::Network(rule)) => {
                let a = risk::score_network(&rule);
                let needs = a.score >= CONFIRMATION_THRESHOLD;
                result.network_rules += 1;
                result.needs_confirmation += usize::from(needs);
                result.lines.push(ValidatedLine {
                    line: line_no,
                    raw: trimmed.to_string(),
                    kind: "network",
                    error: None,
                    risk_score: a.score,
                    risk_band: a.band,
                    risk_factors: a.factors,
                    needs_confirmation: needs,
                });
            }
            Ok(ParsedLine::Cosmetic(rule)) => {
                let a = risk::score_cosmetic(&rule);
                let needs = a.score >= CONFIRMATION_THRESHOLD;
                result.cosmetic_rules += 1;
                result.needs_confirmation += usize::from(needs);
                result.lines.push(ValidatedLine {
                    line: line_no,
                    raw: trimmed.to_string(),
                    kind: "cosmetic",
                    error: None,
                    risk_score: a.score,
                    risk_band: a.band,
                    risk_factors: a.factors,
                    needs_confirmation: needs,
                });
            }
            Ok(_) => {}
            Err(e) => {
                result.errors += 1;
                result.lines.push(ValidatedLine {
                    line: line_no,
                    raw: trimmed.to_string(),
                    kind: "error",
                    error: Some(e.to_string()),
                    risk_score: 0,
                    risk_band: risk::RiskBand::Low,
                    risk_factors: Vec::new(),
                    needs_confirmation: false,
                });
            }
        }
    }

    to_js(&result)
}

/// Compile user filters into DNR rules the extension can register dynamically.
///
/// Ids start at `id_base` so they cannot collide with the static rulesets.
#[wasm_bindgen(js_name = compileUserFilters)]
pub fn compile_user_filters(text: &str, id_base: u32, shadow: bool) -> Result<JsValue, JsValue> {
    let mut out = parse::ParseOutput::default();
    parse::parse_list(&parse::ListSource { id: "user", text }, &mut out);

    let (network, cosmetic, _) =
        fad_filter::dedup::dedup(out.network, out.cosmetic, &out.badfilters);
    let (mut network, _) = fad_filter::optimize::optimize_network(network);
    for rule in &mut network {
        rule.shadow = shadow || rule.shadow;
    }

    let lowered = fad_dnr_lower(&network, id_base);
    let cosmetic = fad_filter::optimize::assign_cosmetic_ids(cosmetic);
    let index = CosmeticIndex::build(&cosmetic, "user");

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct UserCompile {
        rules: Vec<fad_dnr::DnrRule>,
        unsupported: Vec<fad_dnr::Unsupported>,
        cosmetic: CosmeticIndex,
    }

    to_js(&UserCompile {
        rules: lowered.0,
        unsupported: lowered.1,
        cosmetic: index,
    })
}

/// Lower and re-base ids so dynamic rules never collide with static ones.
fn fad_dnr_lower(
    rules: &[NetworkRule],
    id_base: u32,
) -> (Vec<fad_dnr::DnrRule>, Vec<fad_dnr::Unsupported>) {
    let mut lowered = fad_dnr::lower(rules);
    for rule in &mut lowered.rules {
        rule.id += id_base;
    }
    (lowered.rules, lowered.unsupported)
}
