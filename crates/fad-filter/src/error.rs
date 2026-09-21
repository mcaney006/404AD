use thiserror::Error;

/// Errors produced while parsing a single filter line.
///
/// Parsing is line-oriented and fault tolerant: a malformed line is reported and
/// skipped, it never aborts compilation of a whole list.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ParseError {
    #[error("empty pattern")]
    EmptyPattern,
    #[error("unknown filter option `{0}`")]
    UnknownOption(String),
    #[error("option `{0}` does not take a value")]
    UnexpectedOptionValue(String),
    #[error("option `{0}` requires a value")]
    MissingOptionValue(String),
    #[error("unterminated regular expression")]
    UnterminatedRegex,
    #[error("invalid regular expression: {0}")]
    InvalidRegex(String),
    #[error("invalid domain `{0}`")]
    InvalidDomain(String),
    #[error("cosmetic filter has an empty body")]
    EmptyCosmeticBody,
    #[error("unbalanced parentheses in procedural selector")]
    UnbalancedProcedural,
    #[error("scriptlet invocation is malformed")]
    MalformedScriptlet,
    #[error("`{0}` is not supported by the Chromium MV3 backend")]
    Unsupported(&'static str),
    #[error("contradictory options: {0}")]
    Contradictory(&'static str),
}

/// Errors produced by index construction or packing.
#[derive(Debug, Error)]
pub enum BuildError {
    #[error("pattern index construction failed: {0}")]
    PatternIndex(#[from] aho_corasick::BuildError),
}
