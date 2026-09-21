//! Adblock Plus / uBlock Origin syntax front end.
//!
//! This is the only module that understands raw filter text. It emits canonical
//! [`ir`] values; every later stage is syntax agnostic.

use crate::error::ParseError;
use crate::ir::*;
use crate::normalize;

/// A filter list with a stable identifier.
pub struct ListSource<'a> {
    pub id: &'a str,
    pub text: &'a str,
}

/// Result of parsing one or more lists.
#[derive(Debug, Default)]
pub struct ParseOutput {
    pub network: Vec<NetworkRule>,
    pub cosmetic: Vec<CosmeticRule>,
    /// `$badfilter` rules: canonical keys of rules that must be removed.
    pub badfilters: Vec<String>,
    pub errors: Vec<(String, u32, String, ParseError)>,
    pub ignored: u32,
}

/// Parse a whole list.
///
/// `!#shadow on` / `!#shadow off` directives toggle shadow mode for the lines
/// that follow, so a list can carry candidate rules alongside enforced ones.
pub fn parse_list(src: &ListSource<'_>, out: &mut ParseOutput) {
    let mut shadow = false;
    for (idx, raw_line) in src.text.lines().enumerate() {
        let line_no = idx as u32 + 1;
        let line = raw_line.trim();

        if let Some(rest) = line.strip_prefix("!#shadow") {
            shadow = rest.trim().eq_ignore_ascii_case("on");
            out.ignored += 1;
            continue;
        }
        if line.is_empty()
            || line.starts_with('!')
            || (line.starts_with('[') && line.ends_with(']'))
        {
            out.ignored += 1;
            continue;
        }

        let source = SourceRef {
            list: src.id.to_string(),
            line: line_no,
            raw: line.to_string(),
        };
        match parse_line(line, source, shadow) {
            Ok(ParsedLine::Network(r)) => out.network.push(*r),
            Ok(ParsedLine::Cosmetic(r)) => out.cosmetic.push(*r),
            Ok(ParsedLine::Ignored) => out.ignored += 1,
            Ok(ParsedLine::Error { .. }) => unreachable!("errors travel through Err"),
            Err(e) => out
                .errors
                .push((src.id.to_string(), line_no, line.to_string(), e)),
        }
    }
    // `$badfilter` never survives into the rule set; collect and drop.
    let mut bad = Vec::new();
    out.network.retain(|r| {
        if let Modifier::Block = r.modifier {
            if r.source.raw.contains("badfilter") && is_badfilter(&r.source.raw) {
                bad.push(badfilter_key(r));
                return false;
            }
        }
        true
    });
    out.badfilters.extend(bad);
}

fn is_badfilter(raw: &str) -> bool {
    raw.rsplit('$')
        .next()
        .is_some_and(|opts| opts.split(',').any(|o| o.trim() == "badfilter"))
}

/// The canonical key a `$badfilter` rule cancels: the same rule without the
/// `badfilter` option.
fn badfilter_key(rule: &NetworkRule) -> String {
    rule.canonical_key()
}

/// Parse a single non-comment line.
pub fn parse_line(line: &str, source: SourceRef, shadow: bool) -> Result<ParsedLine, ParseError> {
    if let Some((sep_at, sep_len, kind)) = find_cosmetic_separator(line) {
        let domains_part = &line[..sep_at];
        let body = &line[sep_at + sep_len..];
        return parse_cosmetic(domains_part, body, kind, source, shadow)
            .map(|c| ParsedLine::Cosmetic(Box::new(c)));
    }
    parse_network(line, source, shadow).map(|n| ParsedLine::Network(Box::new(n)))
}

// ---------------------------------------------------------------------------
// Cosmetic filters
// ---------------------------------------------------------------------------

/// Locate the cosmetic separator, returning (offset, length, kind).
///
/// Separators, longest first so `#@$#` is not mistaken for `#@#`:
/// `#@$#` `#@?#` `#$#` `#?#` `#@#` `##`
fn find_cosmetic_separator(line: &str) -> Option<(usize, usize, CosmeticKind)> {
    const SEPARATORS: [(&str, CosmeticKind); 6] = [
        ("#@$#", CosmeticKind::Style),
        ("#@?#", CosmeticKind::Unhide),
        ("#$#", CosmeticKind::Style),
        ("#?#", CosmeticKind::Hide),
        ("#@#", CosmeticKind::Unhide),
        ("##", CosmeticKind::Hide),
    ];
    let bytes = line.as_bytes();
    let mut best: Option<(usize, usize, CosmeticKind)> = None;
    for (idx, _) in line.match_indices('#') {
        // A separator must not sit inside an option block of a network rule.
        if bytes[..idx].contains(&b'$') && !bytes[..idx].contains(&b'#') {
            continue;
        }
        for (sep, kind) in SEPARATORS {
            if line[idx..].starts_with(sep) {
                let is_unhide_style = sep == "#@$#";
                let k = if is_unhide_style {
                    CosmeticKind::Style
                } else {
                    kind
                };
                if best.is_none_or(|(b, _, _)| idx < b) {
                    best = Some((idx, sep.len(), k));
                }
                break;
            }
        }
        if best.is_some() {
            break;
        }
    }
    best
}

fn parse_cosmetic(
    domains_part: &str,
    body: &str,
    kind: CosmeticKind,
    source: SourceRef,
    shadow: bool,
) -> Result<CosmeticRule, ParseError> {
    let body = body.trim();
    if body.is_empty() {
        return Err(ParseError::EmptyCosmeticBody);
    }

    let (mut domains, excluded_domains) = normalize::parse_domain_list(domains_part, ',')?;
    let mut excluded_domains = excluded_domains;
    domains.sort();
    domains.dedup();
    excluded_domains.sort();
    excluded_domains.dedup();

    // Scriptlet injection: `+js(name, arg, ...)`
    let is_scriptlet = body.starts_with("+js(") || body.starts_with("script:inject(");
    let (kind, payload) = if is_scriptlet {
        let open = body.find('(').ok_or(ParseError::MalformedScriptlet)?;
        if !body.ends_with(')') {
            return Err(ParseError::MalformedScriptlet);
        }
        let inner = body[open + 1..body.len() - 1].trim();
        if inner.is_empty() {
            return Err(ParseError::MalformedScriptlet);
        }
        let k = if kind == CosmeticKind::Unhide {
            CosmeticKind::UnScriptlet
        } else {
            CosmeticKind::Scriptlet
        };
        (k, inner.to_string())
    } else {
        (kind, body.to_string())
    };

    let (css_prefix, procedural) = if matches!(
        kind,
        CosmeticKind::Scriptlet | CosmeticKind::UnScriptlet | CosmeticKind::Style
    ) {
        (None, Vec::new())
    } else {
        split_procedural(&payload)?
    };

    Ok(CosmeticRule {
        id: 0,
        kind,
        domains,
        excluded_domains,
        payload,
        css_prefix,
        procedural,
        shadow,
        source,
    })
}

/// Split a selector into its plain-CSS prefix and its procedural operators.
///
/// `.ad:has-text(Sponsored)` -> prefix `.ad`, one `HasText` operator.
/// A selector with no procedural operator returns `(None, [])` and is used as-is.
pub fn split_procedural(selector: &str) -> Result<(Option<String>, Vec<Procedural>), ParseError> {
    // `:has()` is not listed: Chromium evaluates it natively and 404AD targets
    // 120 or later, so leaving it in the CSS prefix is both correct and faster.
    const OPS: [&str; 4] = [
        ":has-text(",
        ":upward(",
        ":matches-attr(",
        ":min-text-length(",
    ];

    // An operator that appears in the selector but never at the top level is
    // nested inside `:has()` or a similar functional selector. Neither engine
    // can run it there, so say so instead of shipping a rule that matches
    // nothing. Checked before the split, because a wholly nested operator
    // leaves no top-level operator to split on.
    for op in OPS {
        if selector.contains(op) && find_top_level(selector, op).is_none() {
            return Err(ParseError::Unsupported(
                "a procedural operator nested inside :has()",
            ));
        }
    }

    let mut prefix_end = None;
    for op in OPS {
        if let Some(pos) = find_top_level(selector, op) {
            if prefix_end.is_none_or(|p| pos < p) {
                prefix_end = Some(pos);
            }
        }
    }
    let Some(prefix_end) = prefix_end else {
        return Ok((None, Vec::new()));
    };

    let prefix = selector[..prefix_end].trim().to_string();
    let mut rest = &selector[prefix_end..];
    let mut ops = Vec::new();

    while !rest.is_empty() {
        let matched = OPS.iter().find(|op| rest.starts_with(**op));
        let Some(op) = matched else { break };
        let open = op.len() - 1;
        let close = matching_paren(rest, prefix_end_offset(rest, open))
            .ok_or(ParseError::UnbalancedProcedural)?;
        let arg = rest[open + 1..close].trim();

        let parsed = match *op {
            ":has-text(" => {
                if let Some(re) = arg.strip_prefix('/').and_then(|s| s.strip_suffix('/')) {
                    validate_regex(re)?;
                    Procedural::HasText {
                        needle: re.to_string(),
                        regex: true,
                    }
                } else {
                    Procedural::HasText {
                        needle: arg.to_string(),
                        regex: false,
                    }
                }
            }
            ":upward(" => match arg.parse::<u32>() {
                Ok(n) => Procedural::Upward {
                    steps: Some(n),
                    selector: None,
                },
                Err(_) => Procedural::Upward {
                    steps: None,
                    selector: Some(arg.to_string()),
                },
            },
            ":matches-attr(" => {
                let (name, value) = match arg.split_once('=') {
                    Some((n, v)) => (
                        n.trim().to_string(),
                        Some(v.trim().trim_matches('"').to_string()),
                    ),
                    None => (arg.to_string(), None),
                };
                Procedural::MatchesAttr { name, value }
            }
            ":min-text-length(" => Procedural::MinTextLength {
                len: arg
                    .parse::<u32>()
                    .map_err(|_| ParseError::UnbalancedProcedural)?,
            },
            _ => unreachable!(),
        };
        ops.push(parsed);
        rest = &rest[close + 1..];
    }

    // A procedural operator nested inside `:has()` reaches neither engine: the
    // browser cannot run ours, and ours only splits at the top level. Rejecting
    // it is honest; keeping it would ship a rule that silently matches nothing.
    if OPS.iter().any(|op| prefix.contains(op)) {
        return Err(ParseError::Unsupported(
            "a procedural operator nested inside :has()",
        ));
    }

    let prefix = if prefix.is_empty() {
        None
    } else {
        Some(prefix)
    };
    Ok((prefix, ops))
}

fn prefix_end_offset(s: &str, open: usize) -> usize {
    debug_assert_eq!(s.as_bytes()[open], b'(');
    open
}

/// Index of the `)` that closes the `(` at `open`, honouring nesting.
fn matching_paren(s: &str, open: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0usize;
    for (i, b) in bytes.iter().enumerate().skip(open) {
        match b {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Find `needle` only where it is not already nested inside parentheses.
fn find_top_level(haystack: &str, needle: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let mut depth = 0i32;
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        if depth == 0 && haystack[i..].starts_with(needle) {
            return Some(i);
        }
    }
    None
}

fn validate_regex(source: &str) -> Result<(), ParseError> {
    regex_automata::meta::Regex::new(source)
        .map(|_| ())
        .map_err(|e| ParseError::InvalidRegex(e.to_string()))
}

// ---------------------------------------------------------------------------
// Network filters
// ---------------------------------------------------------------------------

fn parse_network(line: &str, source: SourceRef, shadow: bool) -> Result<NetworkRule, ParseError> {
    let (exception, body) = match line.strip_prefix("@@") {
        Some(rest) => (true, rest),
        None => (false, line),
    };

    let (pattern_str, options_str) = split_options(body);
    if pattern_str.is_empty() && options_str.is_none() {
        return Err(ParseError::EmptyPattern);
    }

    let mut rule = NetworkRule {
        id: 0,
        exception,
        important: false,
        match_case: false,
        pattern: parse_pattern(pattern_str)?,
        party: Party::Any,
        types: ResourceTypes::empty(),
        initiator_domains: Vec::new(),
        excluded_initiator_domains: Vec::new(),
        request_domains: Vec::new(),
        excluded_request_domains: Vec::new(),
        modifier: Modifier::Block,
        shadow,
        source,
    };

    let mut explicit_types = ResourceTypes::empty();
    let mut negated_types = ResourceTypes::empty();
    // Tracked separately from `rule.party` so a contradiction is an error
    // rather than a silent "whichever option came last wins".
    let mut third_party: Option<bool> = None;

    if let Some(options) = options_str {
        for opt in split_options_list(options) {
            let opt = opt.trim();
            if opt.is_empty() {
                continue;
            }
            let (negated, opt) = match opt.strip_prefix('~') {
                Some(rest) => (true, rest),
                None => (false, opt),
            };
            let (name, value) = match opt.split_once('=') {
                Some((n, v)) => (n.trim(), Some(v.trim())),
                None => (opt, None),
            };

            if let Some(bit) = resource_type_from_name(name) {
                if value.is_some() {
                    return Err(ParseError::UnexpectedOptionValue(name.to_string()));
                }
                if negated {
                    negated_types |= bit;
                } else {
                    explicit_types |= bit;
                }
                continue;
            }

            match name {
                "all" => explicit_types |= ResourceTypes::ALL,
                "third-party" | "3p" | "first-party" | "1p" => {
                    let wants_third = matches!(name, "third-party" | "3p") != negated;
                    if third_party.is_some_and(|prev| prev != wants_third) {
                        return Err(ParseError::Contradictory("first-party and third-party"));
                    }
                    third_party = Some(wants_third);
                }
                "match-case" => rule.match_case = !negated,
                "important" => rule.important = !negated,
                "badfilter" => { /* handled by the caller */ }
                "noop" | "_" => {}
                "domain" | "from" => {
                    let v = value.ok_or_else(|| ParseError::MissingOptionValue(name.into()))?;
                    let (inc, exc) = normalize::parse_domain_list(v, '|')?;
                    rule.initiator_domains.extend(inc);
                    rule.excluded_initiator_domains.extend(exc);
                }
                "to" => {
                    let v = value.ok_or_else(|| ParseError::MissingOptionValue(name.into()))?;
                    let (inc, exc) = normalize::parse_domain_list(v, '|')?;
                    rule.request_domains.extend(inc);
                    rule.excluded_request_domains.extend(exc);
                }
                "denyallow" => {
                    let v = value.ok_or_else(|| ParseError::MissingOptionValue(name.into()))?;
                    let (inc, _) = normalize::parse_domain_list(v, '|')?;
                    rule.excluded_request_domains.extend(inc);
                }
                "csp" => {
                    let v = value.unwrap_or("");
                    rule.modifier = Modifier::Csp(v.to_string());
                }
                "inline-script" => {
                    rule.modifier = Modifier::Csp(
                        "script-src 'self' 'unsafe-eval' http: https: data: blob: mediastream: filesystem:".into(),
                    )
                }
                "inline-font" => {
                    rule.modifier = Modifier::Csp(
                        "font-src 'self' http: https: data: blob: mediastream: filesystem:".into(),
                    )
                }
                "removeparam" | "queryprune" => {
                    rule.modifier = Modifier::RemoveParam(match value {
                        None | Some("") => RemoveParam::All,
                        Some(v) => {
                            let (inc, exc) = normalize::split_pipe_list(v);
                            if inc.is_empty() && !exc.is_empty() {
                                RemoveParam::ExceptKeys(exc)
                            } else {
                                RemoveParam::Keys(inc)
                            }
                        }
                    })
                }
                "redirect" | "redirect-rule" => {
                    let v = value.ok_or_else(|| ParseError::MissingOptionValue(name.into()))?;
                    rule.modifier = Modifier::Redirect(v.to_string());
                }
                "empty" => rule.modifier = Modifier::Redirect("empty".into()),
                "mp4" => rule.modifier = Modifier::Redirect("noop-1s.mp4".into()),
                "generichide" | "ghide" => rule.modifier = Modifier::GenericHide,
                "elemhide" | "ehide" => rule.modifier = Modifier::ElemHide,
                "genericblock" => rule.modifier = Modifier::GenericBlock,
                "document" | "doc" => {
                    if exception {
                        rule.modifier = Modifier::Document;
                    }
                    explicit_types |= ResourceTypes::MAIN_FRAME;
                }
                // 404AD extension: compile the rule, observe it, never enforce it.
                "shadow" => rule.shadow = true,
                "popup" | "popunder" => return Err(ParseError::Unsupported("$popup")),
                "webrtc" => return Err(ParseError::Unsupported("$webrtc")),
                "replace" => return Err(ParseError::Unsupported("$replace")),
                other => return Err(ParseError::UnknownOption(other.to_string())),
            }
        }
    }

    rule.party = match third_party {
        Some(true) => Party::Third,
        Some(false) => Party::First,
        None => Party::Any,
    };

    rule.types = if !explicit_types.is_empty() {
        explicit_types
    } else if !negated_types.is_empty() {
        ResourceTypes::implicit_default() & !negated_types
    } else if matches!(rule.modifier, Modifier::RemoveParam(_)) {
        // Tracking parameters ride on navigations, and the implicit default
        // deliberately excludes the top-level document. Stripping a parameter
        // cannot break a navigation the way blocking it would, so an
        // unqualified `$removeparam` covers every type.
        ResourceTypes::ALL
    } else {
        ResourceTypes::implicit_default()
    };
    if !explicit_types.is_empty() && !negated_types.is_empty() {
        rule.types &= !negated_types;
    }

    normalize::normalize_network(&mut rule);
    Ok(rule)
}

/// Split `pattern$options`, respecting `$` inside a `/regex/` pattern.
fn split_options(body: &str) -> (&str, Option<&str>) {
    let bytes = body.as_bytes();
    let regex_pattern = bytes.first() == Some(&b'/');
    let regex_end = if regex_pattern { body.rfind('/') } else { None };

    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        if bytes[i] != b'$' {
            continue;
        }
        if i > 0 && bytes[i - 1] == b'\\' {
            continue;
        }
        if let Some(end) = regex_end {
            if i < end {
                break;
            }
        }
        return (&body[..i], Some(&body[i + 1..]));
    }
    (body, None)
}

/// Split an option list on `,`, keeping commas inside `(...)` (for `$csp`)
/// and inside a `=`-value that itself contains a regex.
fn split_options_list(options: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let bytes = options.as_bytes();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut in_regex = false;
    for i in 0..bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b'/' if i > 0 && bytes[i - 1] == b'=' => in_regex = true,
            b'/' if in_regex => in_regex = false,
            b',' if depth == 0 && !in_regex => {
                parts.push(&options[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&options[start..]);
    parts
}

fn resource_type_from_name(name: &str) -> Option<ResourceTypes> {
    Some(match name {
        "script" => ResourceTypes::SCRIPT,
        "image" | "img" => ResourceTypes::IMAGE,
        "stylesheet" | "css" => ResourceTypes::STYLESHEET,
        "object" | "object-subrequest" => ResourceTypes::OBJECT,
        "xmlhttprequest" | "xhr" => ResourceTypes::XHR,
        "subdocument" | "frame" => ResourceTypes::SUB_FRAME,
        "ping" | "beacon" => ResourceTypes::PING,
        "websocket" => ResourceTypes::WEBSOCKET,
        "webtransport" => ResourceTypes::WEBTRANSPORT,
        "webbundle" => ResourceTypes::WEBBUNDLE,
        "media" => ResourceTypes::MEDIA,
        "font" => ResourceTypes::FONT,
        "csp_report" => ResourceTypes::CSP_REPORT,
        "other" => ResourceTypes::OTHER,
        _ => return None,
    })
}

fn parse_pattern(raw: &str) -> Result<Pattern, ParseError> {
    if raw.is_empty() {
        // `$`-only rules (e.g. `$csp=...,domain=x.com`) match every URL.
        return Ok(Pattern::Plain { raw: "*".into() });
    }
    if raw.len() >= 2 && raw.starts_with('/') && raw.ends_with('/') {
        let source = &raw[1..raw.len() - 1];
        if source.is_empty() {
            return Err(ParseError::UnterminatedRegex);
        }
        validate_regex(source)?;
        return Ok(Pattern::Regex {
            source: source.to_string(),
        });
    }
    if let Some(rest) = raw.strip_prefix("||") {
        let cut = rest.find(['/', '^', '*', '?']).unwrap_or(rest.len());
        let host = normalize::normalize_host(&rest[..cut])?;
        return Ok(Pattern::HostAnchored {
            host,
            tail: rest[cut..].to_string(),
        });
    }
    if let Some(rest) = raw.strip_prefix('|') {
        return Ok(Pattern::LeftAnchored {
            raw: rest.to_string(),
        });
    }
    Ok(Pattern::Plain {
        raw: raw.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> SourceRef {
        SourceRef {
            list: "t".into(),
            line: 1,
            raw: String::new(),
        }
    }

    fn net(line: &str) -> NetworkRule {
        match parse_line(line, src(), false).expect("parse") {
            ParsedLine::Network(r) => *r,
            other => panic!("expected network rule, got {other:?}"),
        }
    }

    fn cos(line: &str) -> CosmeticRule {
        match parse_line(line, src(), false).expect("parse") {
            ParsedLine::Cosmetic(r) => *r,
            other => panic!("expected cosmetic rule, got {other:?}"),
        }
    }

    #[test]
    fn host_anchored_pattern() {
        let r = net("||ads.example.com^$script,third-party");
        assert_eq!(
            r.pattern,
            Pattern::HostAnchored {
                host: "ads.example.com".into(),
                tail: "^".into()
            }
        );
        assert_eq!(r.party, Party::Third);
        assert_eq!(r.types, ResourceTypes::SCRIPT);
        assert!(!r.exception);
    }

    #[test]
    fn exception_with_domain_scope() {
        let r = net("@@||cdn.example.com^$domain=example.org|~sub.example.org");
        assert!(r.exception);
        assert_eq!(r.initiator_domains, vec!["example.org".to_string()]);
        assert_eq!(
            r.excluded_initiator_domains,
            vec!["sub.example.org".to_string()]
        );
    }

    #[test]
    fn negated_types_subtract_from_default() {
        let r = net("/ads/$~script");
        assert!(!r.types.contains(ResourceTypes::SCRIPT));
        assert!(r.types.contains(ResourceTypes::IMAGE));
        // Unqualified rules never touch the top-level document.
        assert!(!r.types.contains(ResourceTypes::MAIN_FRAME));
    }

    #[test]
    fn dollar_inside_regex_is_not_an_option_separator() {
        let r = net("/banner[0-9]+\\.gif$/$image");
        assert!(matches!(r.pattern, Pattern::Regex { .. }));
        assert_eq!(r.types, ResourceTypes::IMAGE);
    }

    #[test]
    fn removeparam_variants() {
        assert_eq!(
            net("||x.com^$removeparam=utm_source|gclid").modifier,
            // Keys are sorted so the same rule always compiles identically.
            Modifier::RemoveParam(RemoveParam::Keys(vec!["gclid".into(), "utm_source".into()]))
        );
        assert_eq!(
            net("||x.com^$removeparam").modifier,
            Modifier::RemoveParam(RemoveParam::All)
        );
    }

    #[test]
    fn contradictory_party_options_are_an_error_not_last_wins() {
        assert_eq!(
            parse_line("||x.com^$third-party,~third-party", src(), false).unwrap_err(),
            ParseError::Contradictory("first-party and third-party")
        );
        // `~first-party` and `third-party` say the same thing and must agree.
        assert_eq!(net("||x.com^$third-party,~first-party").party, Party::Third);
    }

    #[test]
    fn unqualified_removeparam_covers_navigations() {
        let r = net("$removeparam=utm_source");
        assert!(r.types.contains(ResourceTypes::MAIN_FRAME));
        // But a plain block still must not touch the document.
        assert!(!net("||x.com^").types.contains(ResourceTypes::MAIN_FRAME));
    }

    #[test]
    fn cosmetic_generic_and_scoped() {
        let g = cos("##.ad-banner");
        assert!(g.is_generic());
        assert_eq!(g.anchor_token().as_deref(), Some(".ad-banner"));

        let s = cos("example.com,~m.example.com##.promo");
        assert_eq!(s.domains, vec!["example.com".to_string()]);
        assert_eq!(s.excluded_domains, vec!["m.example.com".to_string()]);
    }

    #[test]
    fn cosmetic_unhide_and_scriptlet() {
        assert_eq!(cos("example.com#@#.promo").kind, CosmeticKind::Unhide);
        let s = cos("example.com##+js(set-constant, adsEnabled, false)");
        assert_eq!(s.kind, CosmeticKind::Scriptlet);
        assert_eq!(s.payload, "set-constant, adsEnabled, false");
    }

    #[test]
    fn plain_has_stays_css_and_never_becomes_procedural() {
        // Chromium evaluates `:has()` natively; routing it through the JS engine
        // would be slower and would keep it out of the injected stylesheet.
        let r = cos("example.com##ytd-rich-item-renderer:has(ytd-ad-slot-renderer)");
        assert!(r.procedural.is_empty());
        assert_eq!(r.css_prefix, None);
        assert_eq!(
            r.payload,
            "ytd-rich-item-renderer:has(ytd-ad-slot-renderer)"
        );
    }

    #[test]
    fn has_combines_with_a_following_procedural_operator() {
        let r = cos("example.com##li:has(.badge):has-text(Sponsored)");
        // The prefix keeps native `:has()`, so querySelectorAll still narrows.
        assert_eq!(r.css_prefix.as_deref(), Some("li:has(.badge)"));
        assert_eq!(
            r.procedural,
            vec![Procedural::HasText {
                needle: "Sponsored".into(),
                regex: false
            }]
        );
    }

    #[test]
    fn a_procedural_operator_nested_inside_has_is_rejected() {
        assert_eq!(
            parse_line("example.com##li:has(:has-text(Ad))", src(), false).unwrap_err(),
            ParseError::Unsupported("a procedural operator nested inside :has()")
        );
    }

    #[test]
    fn procedural_selector_splits_into_prefix_and_ops() {
        let r = cos("example.com##div.item:has-text(Sponsored):upward(2)");
        assert_eq!(r.css_prefix.as_deref(), Some("div.item"));
        assert_eq!(
            r.procedural,
            vec![
                Procedural::HasText {
                    needle: "Sponsored".into(),
                    regex: false
                },
                Procedural::Upward {
                    steps: Some(2),
                    selector: None
                },
            ]
        );
    }

    #[test]
    fn unsupported_options_are_reported_not_silently_dropped() {
        assert_eq!(
            parse_line("||x.com^$popup", src(), false).unwrap_err(),
            ParseError::Unsupported("$popup")
        );
    }

    #[test]
    fn shadow_directive_marks_following_rules() {
        let mut out = ParseOutput::default();
        parse_list(
            &ListSource {
                id: "t",
                text: "||a.com^\n!#shadow on\n||b.com^\n!#shadow off\n||c.com^",
            },
            &mut out,
        );
        let shadow: Vec<bool> = out.network.iter().map(|r| r.shadow).collect();
        assert_eq!(shadow, vec![false, true, false]);
    }
}
