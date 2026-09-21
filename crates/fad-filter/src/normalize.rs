//! Canonicalization. Two rules that mean the same thing must normalize to the
//! same bytes, otherwise deduplication and deterministic compilation both fail.

use crate::error::ParseError;
use crate::ir::{NetworkRule, Pattern};

/// Lowercase, strip a leading dot, and punycode-encode a hostname.
///
/// Entity patterns (`google.*`) keep their trailing wildcard: only the labelled
/// prefix is encoded.
pub fn normalize_host(host: &str) -> Result<String, ParseError> {
    let host = host.trim().trim_start_matches('.');
    if host.is_empty() {
        return Err(ParseError::InvalidDomain(host.to_string()));
    }
    if let Some(prefix) = host.strip_suffix(".*") {
        let encoded = encode_ascii(prefix)?;
        return Ok(format!("{encoded}.*"));
    }
    encode_ascii(host)
}

fn encode_ascii(host: &str) -> Result<String, ParseError> {
    let lowered = host.to_lowercase();
    if lowered.is_ascii() {
        // Fast path: already ASCII, nothing for IDNA to do.
        if lowered.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '*' | ':' | '[' | ']')
        }) {
            return Ok(lowered);
        }
        return Err(ParseError::InvalidDomain(host.to_string()));
    }
    idna::domain_to_ascii(&lowered).map_err(|_| ParseError::InvalidDomain(host.to_string()))
}

/// Split a `~`-aware list into (included, excluded), normalizing each entry.
pub fn parse_domain_list(raw: &str, sep: char) -> Result<(Vec<String>, Vec<String>), ParseError> {
    let mut included = Vec::new();
    let mut excluded = Vec::new();
    for entry in raw.split(sep) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        match entry.strip_prefix('~') {
            Some(rest) => excluded.push(normalize_host(rest)?),
            None => included.push(normalize_host(entry)?),
        }
    }
    included.sort();
    included.dedup();
    excluded.sort();
    excluded.dedup();
    Ok((included, excluded))
}

/// Split a `|`-separated value list into (plain, negated) entries, unmodified.
pub fn split_pipe_list(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut plain = Vec::new();
    let mut negated = Vec::new();
    for entry in raw.split('|') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        match entry.strip_prefix('~') {
            Some(rest) => negated.push(rest.to_string()),
            None => plain.push(entry.to_string()),
        }
    }
    plain.sort();
    plain.dedup();
    negated.sort();
    negated.dedup();
    (plain, negated)
}

/// Final canonicalization pass over a parsed network rule.
pub fn normalize_network(rule: &mut NetworkRule) {
    for list in [
        &mut rule.initiator_domains,
        &mut rule.excluded_initiator_domains,
        &mut rule.request_domains,
        &mut rule.excluded_request_domains,
    ] {
        list.sort();
        list.dedup();
    }
    // A domain that is both included and excluded is contradictory; the
    // exclusion wins, matching Adblock Plus behaviour.
    let excluded = rule.excluded_initiator_domains.clone();
    rule.initiator_domains.retain(|d| !excluded.contains(d));

    rule.pattern = canonicalize_pattern(std::mem::replace(
        &mut rule.pattern,
        Pattern::Plain { raw: String::new() },
    ));

    if !rule.match_case {
        if let Pattern::HostAnchored { host, .. } = &mut rule.pattern {
            *host = host.to_lowercase();
        }
    }
}

/// Collapse redundant wildcards and drop no-op anchors.
pub fn canonicalize_pattern(pattern: Pattern) -> Pattern {
    match pattern {
        Pattern::Plain { raw } => Pattern::Plain {
            raw: collapse_wildcards(&raw),
        },
        Pattern::LeftAnchored { raw } => Pattern::LeftAnchored {
            raw: collapse_wildcards(&raw),
        },
        Pattern::HostAnchored { host, tail } => Pattern::HostAnchored {
            host,
            tail: collapse_wildcards(&tail),
        },
        p @ Pattern::Regex { .. } => p,
    }
}

/// `a**b` -> `a*b`, and a leading or trailing `*` is meaningless for a
/// substring match, so it is removed.
fn collapse_wildcards(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_star = false;
    for c in raw.chars() {
        if c == '*' {
            if prev_star {
                continue;
            }
            prev_star = true;
        } else {
            prev_star = false;
        }
        out.push(c);
    }
    let trimmed = out.trim_matches('*');
    if trimmed.is_empty() && !out.is_empty() {
        return "*".to_string();
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_lowercased_and_punycoded() {
        assert_eq!(
            normalize_host("ADS.Example.COM").unwrap(),
            "ads.example.com"
        );
        assert_eq!(
            normalize_host(".leading.dot.com").unwrap(),
            "leading.dot.com"
        );
        assert_eq!(normalize_host("bücher.de").unwrap(), "xn--bcher-kva.de");
        assert_eq!(normalize_host("Google.*").unwrap(), "google.*");
    }

    #[test]
    fn wildcards_collapse_deterministically() {
        assert_eq!(collapse_wildcards("*ads**banner*"), "ads*banner");
        assert_eq!(collapse_wildcards("***"), "*");
        assert_eq!(collapse_wildcards("/ads/"), "/ads/");
    }

    #[test]
    fn domain_lists_split_and_sort() {
        let (inc, exc) = parse_domain_list("b.com|~x.com|a.com|~a.org", '|').unwrap();
        assert_eq!(inc, vec!["a.com".to_string(), "b.com".to_string()]);
        assert_eq!(exc, vec!["a.org".to_string(), "x.com".to_string()]);
    }
}
