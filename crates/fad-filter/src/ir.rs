//! Canonical intermediate representation for 404AD filters.
//!
//! Everything downstream (dedup, optimization, DNR lowering, cosmetic packing,
//! diagnostics) reads this IR and nothing else. Parsing is the only place that
//! touches raw Adblock Plus syntax.

use bitflags::bitflags;
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

bitflags! {
    /// Request resource types, aligned with Chromium `declarativeNetRequest` types.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
    pub struct ResourceTypes: u32 {
        const MAIN_FRAME   = 1 << 0;
        const SUB_FRAME    = 1 << 1;
        const STYLESHEET   = 1 << 2;
        const SCRIPT       = 1 << 3;
        const IMAGE        = 1 << 4;
        const FONT         = 1 << 5;
        const OBJECT       = 1 << 6;
        const XHR          = 1 << 7;
        const PING         = 1 << 8;
        const CSP_REPORT   = 1 << 9;
        const MEDIA        = 1 << 10;
        const WEBSOCKET    = 1 << 11;
        const WEBTRANSPORT = 1 << 12;
        const WEBBUNDLE    = 1 << 13;
        const OTHER        = 1 << 14;
    }
}

impl ResourceTypes {
    /// Every type Chromium can match on.
    pub const ALL: Self = Self::all();

    /// Types a filter matches when it declares no explicit type option.
    ///
    /// Adblock semantics: an unqualified rule never blocks the top-level
    /// document. Blocking a main frame requires an explicit `$document`.
    pub fn implicit_default() -> Self {
        Self::all() & !Self::MAIN_FRAME
    }

    /// Chromium wire names, emitted in a stable order so output is deterministic.
    pub fn dnr_names(self) -> Vec<&'static str> {
        const TABLE: [(ResourceTypes, &str); 15] = [
            (ResourceTypes::MAIN_FRAME, "main_frame"),
            (ResourceTypes::SUB_FRAME, "sub_frame"),
            (ResourceTypes::STYLESHEET, "stylesheet"),
            (ResourceTypes::SCRIPT, "script"),
            (ResourceTypes::IMAGE, "image"),
            (ResourceTypes::FONT, "font"),
            (ResourceTypes::OBJECT, "object"),
            (ResourceTypes::XHR, "xmlhttprequest"),
            (ResourceTypes::PING, "ping"),
            (ResourceTypes::CSP_REPORT, "csp_report"),
            (ResourceTypes::MEDIA, "media"),
            (ResourceTypes::WEBSOCKET, "websocket"),
            (ResourceTypes::WEBTRANSPORT, "webtransport"),
            (ResourceTypes::WEBBUNDLE, "webbundle"),
            (ResourceTypes::OTHER, "other"),
        ];
        TABLE
            .iter()
            .filter(|(bit, _)| self.contains(*bit))
            .map(|(_, name)| *name)
            .collect()
    }
}

/// First-party / third-party constraint.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default,
)]
pub enum Party {
    #[default]
    Any,
    First,
    Third,
}

/// The URL-matching shape of a network rule.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Pattern {
    /// Matches anywhere in the URL. May contain `*` wildcards and a trailing `^`.
    Plain { raw: String },
    /// `||host^path` — matches the host or any subdomain of it.
    HostAnchored { host: String, tail: String },
    /// `|scheme://...` — anchored at the start of the URL.
    LeftAnchored { raw: String },
    /// `/regex/` — compiled with `regex-automata` and lowered to `regexFilter`.
    Regex { source: String },
}

impl Pattern {
    /// The longest literal run in the pattern, used to seed the pattern index
    /// and to reason about breakage risk. `None` for patterns with no literal.
    pub fn longest_literal(&self) -> Option<&str> {
        match self {
            Pattern::Plain { raw } | Pattern::LeftAnchored { raw } => raw
                .split(['*', '^'])
                .filter(|s| !s.is_empty())
                .max_by_key(|s| s.len()),
            Pattern::HostAnchored { host, .. } => Some(host.as_str()),
            Pattern::Regex { .. } => None,
        }
    }

    /// Total literal character count, a proxy for how specific a pattern is.
    pub fn literal_len(&self) -> usize {
        match self {
            Pattern::Plain { raw } | Pattern::LeftAnchored { raw } => raw
                .chars()
                .filter(|c| !matches!(c, '*' | '^' | '|'))
                .count(),
            Pattern::HostAnchored { host, tail } => host.len() + tail.len(),
            Pattern::Regex { source } => source.len() / 2,
        }
    }

    pub fn is_regex(&self) -> bool {
        matches!(self, Pattern::Regex { .. })
    }
}

/// Rule modifiers that change *what happens* rather than *what matches*.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub enum Modifier {
    /// Plain block (or, for exceptions, plain allow).
    #[default]
    Block,
    /// `$csp=...` — inject a Content-Security-Policy response header.
    Csp(String),
    /// `$removeparam=...` — strip query parameters instead of blocking.
    RemoveParam(RemoveParam),
    /// `$redirect=...` — serve a bundled neutered resource.
    Redirect(String),
    /// `$generichide` — suppress generic cosmetic filters on the document.
    GenericHide,
    /// `$elemhide` — suppress all cosmetic filters on the document.
    ElemHide,
    /// `$genericblock` — suppress generic network filters on the document.
    GenericBlock,
    /// `$document` exception — allow every request under the document.
    Document,
}

/// Parsed form of `$removeparam`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RemoveParam {
    /// `$removeparam` with no value: strip the entire query string.
    All,
    /// `$removeparam=a|b` — strip exactly these keys.
    Keys(Vec<String>),
    /// `$removeparam=~a` — strip everything except these keys.
    ExceptKeys(Vec<String>),
}

/// Where a rule came from, kept for diagnostics and explainability.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct SourceRef {
    /// Stable id of the originating list (e.g. `404ad-base`, `user`).
    pub list: String,
    /// 1-based line number inside that list.
    pub line: u32,
    /// The raw filter text, verbatim.
    pub raw: String,
}

/// A fully normalized network rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkRule {
    /// Assigned after the deterministic sort. Zero until then.
    pub id: u32,
    pub exception: bool,
    pub important: bool,
    pub match_case: bool,
    pub pattern: Pattern,
    pub party: Party,
    pub types: ResourceTypes,
    /// Document (initiator) domains this rule is restricted to. Sorted, unique.
    pub initiator_domains: Vec<String>,
    pub excluded_initiator_domains: Vec<String>,
    /// Request (target) domains, from `$denyallow` / `$to`.
    pub request_domains: Vec<String>,
    pub excluded_request_domains: Vec<String>,
    pub modifier: Modifier,
    /// Shadow rules are compiled and observed but never change behaviour.
    pub shadow: bool,
    pub source: SourceRef,
}

impl NetworkRule {
    /// Is this rule scoped to specific document domains?
    pub fn is_scoped(&self) -> bool {
        !self.initiator_domains.is_empty() || !self.request_domains.is_empty()
    }

    /// Everything that determines matching and action, excluding provenance.
    ///
    /// Two rules with the same canonical key are semantically identical even if
    /// they were written differently or came from different lists. This is the
    /// basis of semantic deduplication and of deterministic id assignment.
    pub fn canonical_key(&self) -> String {
        let mut s = String::with_capacity(96);
        let _ = write!(
            s,
            "{}|{}|{}|{}|{:?}|{:?}|{:08x}",
            u8::from(self.exception),
            u8::from(self.important),
            u8::from(self.match_case),
            u8::from(self.shadow),
            self.pattern,
            self.party,
            self.types.bits(),
        );
        for (tag, list) in [
            ("i", &self.initiator_domains),
            ("xi", &self.excluded_initiator_domains),
            ("r", &self.request_domains),
            ("xr", &self.excluded_request_domains),
        ] {
            let _ = write!(s, "|{tag}={}", list.join(","));
        }
        let _ = write!(s, "|{:?}", self.modifier);
        s
    }

    /// The key rules must agree on to be merged by domain union.
    pub fn merge_key(&self) -> String {
        let mut s = self.canonical_key();
        // Strip the initiator-domain segment: that is the axis we merge along.
        if let Some(pos) = s.find("|i=") {
            let rest_start = s[pos + 3..]
                .find('|')
                .map(|p| pos + 3 + p)
                .unwrap_or(s.len());
            s.replace_range(pos..rest_start, "|i=*");
        }
        s
    }
}

/// What a cosmetic rule does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum CosmeticKind {
    /// `##selector` — hide matching elements.
    Hide,
    /// `#@#selector` — cancel a hide rule.
    Unhide,
    /// `#$#selector { ... }` — apply a style declaration.
    Style,
    /// `##+js(name, args...)` — run a bundled scriptlet in the page.
    Scriptlet,
    /// `#@#+js(...)` — cancel a scriptlet.
    UnScriptlet,
}

/// Procedural operators that CSS alone cannot express.
///
/// `:has()` is deliberately absent. Chromium has supported it natively since
/// 105 and 404AD targets 120 or later, so a `:has()` selector is left in the
/// plain-CSS prefix and evaluated by the browser's own selector engine. Routing
/// it through JS would be slower and would hide it from the injected stylesheet.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Procedural {
    /// `:has-text(needle)` / `:has-text(/re/)`
    HasText { needle: String, regex: bool },
    /// `:upward(n)` or `:upward(selector)`
    Upward {
        steps: Option<u32>,
        selector: Option<String>,
    },
    /// `:matches-attr(name=value)`
    MatchesAttr { name: String, value: Option<String> },
    /// `:min-text-length(n)`
    MinTextLength { len: u32 },
}

/// A fully normalized cosmetic rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CosmeticRule {
    pub id: u32,
    pub kind: CosmeticKind,
    /// Hostnames this rule applies to. Empty means generic (every site).
    /// An entry ending in `.*` is an entity match (`google.*`).
    pub domains: Vec<String>,
    pub excluded_domains: Vec<String>,
    /// The CSS selector, style body, or scriptlet invocation.
    pub payload: String,
    /// The plain-CSS prefix of a procedural selector, used to narrow candidates.
    pub css_prefix: Option<String>,
    pub procedural: Vec<Procedural>,
    pub shadow: bool,
    pub source: SourceRef,
}

impl CosmeticRule {
    pub fn is_generic(&self) -> bool {
        self.domains.is_empty()
    }

    pub fn canonical_key(&self) -> String {
        format!(
            "{:?}|{}|{}|{}|{:?}|{}",
            self.kind,
            self.domains.join(","),
            self.excluded_domains.join(","),
            self.payload,
            self.procedural,
            u8::from(self.shadow),
        )
    }

    /// The class or id token a generic selector keys off, if it has one.
    ///
    /// Generic selectors are only worth evaluating when their anchor token is
    /// actually present in the document. This is the single largest cosmetic
    /// performance lever, and it is why the runtime index exists.
    pub fn anchor_token(&self) -> Option<String> {
        let sel = self.css_prefix.as_deref().unwrap_or(&self.payload);
        let bytes = sel.as_bytes();
        let mut best: Option<String> = None;
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i] as char;
            if c == '.' || c == '#' {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len() {
                    let ch = bytes[end] as char;
                    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                        end += 1;
                    } else {
                        break;
                    }
                }
                if end > start {
                    let tok = format!("{}{}", c, &sel[start..end]);
                    if best.as_ref().is_none_or(|b| tok.len() > b.len()) {
                        best = Some(tok);
                    }
                }
                i = end;
            } else {
                i += 1;
            }
        }
        best
    }
}

/// One parsed line: either a rule, a comment/metadata line, or an error.
#[derive(Debug, Clone)]
pub enum ParsedLine {
    Network(Box<NetworkRule>),
    Cosmetic(Box<CosmeticRule>),
    /// `! comment` or `[Adblock Plus 2.0]` header.
    Ignored,
    Error {
        line: u32,
        raw: String,
        error: crate::error::ParseError,
    },
}
