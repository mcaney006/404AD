import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

/**
 * Ruleset declarations are produced by `fad-compile build`, which knows how many
 * rules exist, how they split across files, and which categories ship enabled.
 * Reading them here keeps the manifest and the compiled rules in lockstep: there
 * is no second place where a ruleset can be forgotten or mis-numbered.
 */
function ruleResources(): Array<{ id: string; enabled: boolean; path: string }> {
  const generated = resolve(__dirname, 'public/generated/rulesets.json');
  try {
    return JSON.parse(readFileSync(generated, 'utf8'));
  } catch {
    // Missing on a fresh checkout, because `fad-compile` has not run yet. This
    // used to throw, which made `bun install` fail on a clean clone: the
    // postinstall hook runs `wxt prepare`, and preparing types has no business
    // requiring compiled rules.
    //
    // Returning empty is only safe because it is not the last check. A build
    // that reaches the packaging step without rulesets fails there, where the
    // mistake actually matters.
    console.warn(
      `404AD: ${generated} not found; the manifest will declare no rulesets. Run \`bun run build:filters\`.`,
    );
    return [];
  }
}

export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  vite: () => ({
    plugins: [preact()],
    build: {
      // Content blockers get read by reviewers and by users. Keep the shipped
      // bundle traceable back to this source tree.
      minify: false,
      sourcemap: false,
    },
  }),
  manifestVersion: 3,
  manifest: {
    name: '404AD',
    short_name: '404AD',
    description:
      'A high-performance, privacy-first content blocker. No telemetry, no account, no cloud.',
    version: '0.1.0',
    minimum_chrome_version: '120',
    permissions: [
      // The network data plane. Chromium matches every request itself.
      'declarativeNetRequest',
      // Rule-match feedback, which powers statistics, shadow-mode observation
      // and the diagnostics panel. Granted to unpacked and policy-installed
      // extensions; every consumer degrades gracefully without it.
      'declarativeNetRequestFeedback',
      'storage',
      'tabs',
    ],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: '404AD',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
      },
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    web_accessible_resources: [
      {
        // The WASM binary is fetched by extension URL, never from the network,
        // and the scriptlet runtime is loaded by the content script as a
        // `<script src=…>` element rather than injected as a string.
        resources: ['wasm/*', 'redirect/*', 'scriptlets-runtime.js'],
        matches: ['<all_urls>'],
      },
    ],
    declarative_net_request: {
      rule_resources: ruleResources(),
    },
    // No remote code, ever.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
