import { beforeEach, describe, expect, test } from "bun:test";
import { CONFIG_ATTRIBUTE, injectScriptlets, resetScriptletInjection } from "./scriptlets";
import type { ScriptletEntry } from "../core/protocol";

function entry(partial: Partial<ScriptletEntry>): ScriptletEntry {
  return { ruleId: 1, name: "nowebrtc", args: [], shadow: false, ...partial };
}

function injectedScript(): HTMLScriptElement | null {
  return document.querySelector("script[src*='scriptlets-runtime']");
}

function config(): ScriptletEntry[] {
  const raw = injectedScript()?.getAttribute(CONFIG_ATTRIBUTE);
  return raw ? (JSON.parse(raw) as ScriptletEntry[]) : [];
}

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  resetScriptletInjection();
});

describe("injectScriptlets", () => {
  test("injects a script element pointing at a packaged resource", () => {
    expect(injectScriptlets([entry({})])).toBe(true);
    const element = injectedScript();
    // Never inline, never remote: an extension URL. That is what makes this
    // work on sites whose CSP forbids inline script.
    expect(element?.src).toContain("chrome-extension://");
    expect(element?.src).toContain("scriptlets-runtime.js");
  });

  test("carries the configuration in a data attribute", () => {
    injectScriptlets([entry({ name: "set-constant", args: ["a.b", "false"] })]);
    expect(config()).toEqual([
      { ruleId: 1, name: "set-constant", args: ["a.b", "false"], shadow: false },
    ]);
  });

  test("does nothing when there is nothing to inject", () => {
    expect(injectScriptlets([])).toBe(false);
    expect(injectedScript()).toBeNull();
  });

  test("shadow scriptlets are never injected", () => {
    // A shadow rule must not change what the page does, and a scriptlet is the
    // most behaviour-changing thing in the system.
    expect(injectScriptlets([entry({ shadow: true })])).toBe(false);
    expect(injectedScript()).toBeNull();
  });

  test("injects at most once per document", () => {
    expect(injectScriptlets([entry({})])).toBe(true);
    expect(injectScriptlets([entry({ name: "nowebrtc" })])).toBe(false);
    expect(document.querySelectorAll("script[src*='scriptlets-runtime']")).toHaveLength(1);
  });

  test("the transport scriptlet receives its WASM URL from the extension realm", () => {
    // The main world has no chrome APIs, so it cannot build this URL itself.
    injectScriptlets([entry({ name: "404ad-yt-transport", args: [] })]);
    const [transport] = config();
    expect(transport?.args[0]).toContain("chrome-extension://");
    expect(transport?.args[0]).toContain("fad_yt_wasm_bg.wasm");
  });

  test("other scriptlets keep their arguments untouched", () => {
    injectScriptlets([entry({ name: "set-constant", args: ["x", "1"] })]);
    expect(config()[0]?.args).toEqual(["x", "1"]);
  });
});
