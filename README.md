# 404AD

A high-performance, privacy-first content blocker for Chromium, built on Manifest V3.

No account. No server. No telemetry. The extension makes no network requests of its own:
filter lists are compiled into the package at build time, and the WASM runtime is loaded
from the extension itself.

## Load it

```bash
bun install
bun run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and
select:

```
dist/404ad-chrome-mv3
```

That path is deterministic. `bun run build` always produces it, and it is a plain copy of
the WXT output, so the two can never disagree. The directory is committed, so a fresh
clone can be loaded without building anything first.

## The one architectural rule

**Chromium's `declarativeNetRequest` engine owns the network hot path.**

Nothing in 404AD inspects, intercepts or decides a network request. There is no blocking
`webRequest` listener, no JavaScript request filter, and no WASM matcher in front of the
network. Rust and WASM are the control plane; Chromium is the data plane.

```
                  FILTER LISTS  (lists/*.txt)
                         │
                         ▼
             ┌───────────────────────┐
             │  RUST FILTER COMPILER │   fad-compile
             │  parse → normalize →  │
             │  dedup → optimize     │
             └───────────┬───────────┘
                         │  canonical IR
         ┌───────────────┴────────────────┐
         ▼                                ▼
   DNR NETWORK IR                    COSMETIC IR
   rules/*.json                      cosmetic.bin (postcard)
         │                                │
         ▼                                ▼
  ┌──────────────┐               ┌──────────────────┐
  │ Chromium DNR │               │  Rust/WASM index │
  │  (data plane)│               │  (control plane) │
  └──────┬───────┘               └────────┬─────────┘
         │ onRuleMatchedDebug              │ resolveDocument
         └───────────────┬─────────────────┘
                         ▼
                 CONTENT RUNTIME
                         │
         ┌───────────────┴────────────────┐
         ▼                                ▼
   generic cosmetic                 site adapters
   filtering                              │
                                          ▼
                                       YouTube
```

## What is in the box

| Capability | Where it lives |
| --- | --- |
| Chromium-native network blocking | `crates/fad-dnr`, `rules/*.json` |
| Rust filter-list compiler | `crates/fad-filter`, `crates/fad-compiler` |
| Rust/WASM runtime | `crates/fad-wasm` |
| Cosmetic filtering | `crates/fad-filter/src/cosmetic_index.rs`, `packages/extension/src/content/` |
| Custom filter lists | `lists/manifest.json` |
| Custom user filters | `packages/extension/src/core/userfilters.ts` |
| Diagnostics and explainability | `crates/fad-filter/src/matcher.rs`, options → Overview |
| Per-site controls | `packages/extension/src/core/sites.ts` |
| YouTube runtime adapter | `packages/extension/src/adapters/youtube.ts` |
| Local-only adaptive statistics | `packages/extension/src/core/stats.ts` |
| Shadow-mode rules | `lists/404ad-candidates.txt`, options → Shadow mode |
| Breakage-risk scoring | `crates/fad-filter/src/risk.rs` |
| Deterministic compilation | `fad-compile verify` |

## Three ideas worth explaining

### Shadow mode is a real `allow` rule, not a simulation

A shadow rule compiles into Chromium as an `allow` at **priority 1**. Nothing in the
system ranks below priority 1, so a shadow rule can never outrank a real block and can
never change what happens to a request. It still matches, and every match is reported
through `onRuleMatchedDebug`.

That means a candidate rule is measured against real traffic, by the real engine, with
zero risk. Promote it once its match rate and site coverage justify it.

Priority bands, shared by the lowerer and the reference matcher so they cannot drift:

| Priority | Meaning |
| --- | --- |
| 1 | shadow observation (`allow`, inert) |
| 5 | `$removeparam` |
| 10 / 20 | block (generic / domain-scoped) |
| 30 | `$redirect` |
| 40 | `$csp` |
| 100 | exception (`@@`) |
| 200 | `$important` block |
| 1000 | per-site disable (`allowAllRequests`) |

### Breakage risk is scored, and gates what you write

Every rule gets a transparent 0-100 score from an additive model with documented terms
(`crates/fad-filter/src/risk.rs`). A rule that cannot stop a request is never scored like
one that can: `$removeparam=utm_source` scores 5, while `||example.com^$document` scores
58.

The score does real work. A **custom filter** you write that scores High or above is
compiled into shadow mode until you explicitly confirm it. You can still write
`##div`; it just gets observed before it is enforced.

### Generic cosmetic selectors are gated on tokens actually in the page

A full list ships tens of thousands of generic selectors. A page contains a few hundred
class and id tokens. The WASM index takes the tokens and returns only the selectors that
can possibly match, so the content script never receives the rest.

Measured on a synthetic index of 20,000 generic selectors and 2,000 hosts
(`cargo bench -p fad-filter`, Apple Silicon):

| Operation | Time |
| --- | --- |
| `select_generic` (token-gated) | 26.7 µs |
| ship every generic selector (baseline) | 70.0 µs |
| `lookup_host` | 314 ns |
| decode index, postcard | 5.00 ms |
| decode index, `serde_json` | 6.65 ms |

`postcard` is used for the shipped index because it measured 40.1% smaller and 25% faster
to decode than the JSON that was already in the build. That is the whole justification;
the human-readable `cosmetic.json` is still emitted for debugging.

## Determinism

The same inputs always produce byte-identical output, including rule ids. Rule ids are
assigned by sorting on a canonical key, so they are a pure function of rule content and
the diagnostics map stays valid across rebuilds.

```bash
bun run verify
# deterministic: two independent compiles agree on all 12 artifacts (build 6563…)
```

## Working on it

```bash
bun run build:wasm        # cargo + wasm-pack -> src/wasm, public/wasm
bun run build:filters     # fad-compile -> public/rules, public/generated
bun run build:extension   # WXT -> packages/extension/.output/chrome-mv3
bun run build             # all of the above, then package to dist/

bun run test              # cargo test --workspace, then bun test
bun run test:e2e          # Playwright against a real Chromium
bun run verify            # prove compilation is deterministic
bun run lint              # oxlint
bun run fmt               # oxfmt
```

Ask the compiler why a request is blocked:

```bash
cargo run -q -p fad-compiler -- explain \
  --url https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js \
  --initiator https://news.example.com/article \
  --type script
```

Fuzz the parser (needs `cargo install cargo-fuzz` and a nightly toolchain):

```bash
scripts/fuzz.sh parse_line
scripts/fuzz.sh compile_list
scripts/fuzz.sh cosmetic_index
```

## Filter lists

`lists/manifest.json` declares each list, its ruleset category and whether it ships
enabled. Lists use Adblock Plus syntax with two 404AD additions:

* `!#shadow on` / `!#shadow off` — a directive that marks the lines between them as
  shadow-mode candidates.
* `$shadow` — the same thing for a single rule.

The compiler enforces Chromium's ceilings at build time rather than letting Chromium fail
at load time: 30,000 enabled static rules, 1,000 regex rules, 50 enabled rulesets. Rules
the MV3 backend cannot express (`$popup`, `$removeparam` with `~` inversion) are reported
in `generated/build-report.json`, never silently dropped.

## Permissions, and why each one exists

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | the network data plane |
| `declarativeNetRequestFeedback` | rule-match reporting for statistics, shadow observations and diagnostics |
| `storage` | settings, per-site rules and local counters |
| `scripting` | injecting scriptlets into the page's main world |
| `webNavigation` | the earliest reliable per-navigation hook for that injection |
| `tabs` | resolving the active tab's host for the popup |
| `<all_urls>` | filtering is not useful on a subset of the web |

There is deliberately no `webRequest` and no `webRequestBlocking`.

`declarativeNetRequestFeedback` is only granted to unpacked and policy-installed
extensions. Blocking works either way; statistics and shadow observations do not, and the
options page says so plainly when the feedback channel is unavailable.

## Browser support

Chromium and Google Chrome, Manifest V3, version 120 or later.

The boundaries are drawn so Firefox or Safari could be added later — the compiler emits
an IR, and `fad-dnr` is one lowering of it — but Chrome MV3 is the production target and
nothing is diluted to accommodate a second one today.

## Licence

MIT. See [LICENSE](LICENSE).
