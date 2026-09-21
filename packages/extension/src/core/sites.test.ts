import { beforeEach, describe, expect, test } from "bun:test";
import { resetChromeStorage } from "../../../../tests/setup";
import { hostSuffixes, loadSites, resolveMode, setSiteMode } from "./sites";

describe("hostSuffixes", () => {
  test("walks up to the two-label boundary", () => {
    expect(hostSuffixes("a.b.example.com")).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
    ]);
  });

  test("a two-label host is its own only suffix", () => {
    expect(hostSuffixes("example.com")).toEqual(["example.com"]);
  });

  test("normalises case and a trailing root dot", () => {
    expect(hostSuffixes("WWW.Example.COM.")).toEqual(["www.example.com", "example.com"]);
  });

  test("a single-label host still resolves", () => {
    expect(hostSuffixes("localhost")).toEqual(["localhost"]);
  });

  test("ordering is most-specific-first so the nearest rule wins", () => {
    expect(hostSuffixes("app.example.com")[0]).toBe("app.example.com");
  });
});

describe("per-site rules", () => {
  beforeEach(() => {
    resetChromeStorage();
  });

  test("the most specific rule wins", async () => {
    await setSiteMode("example.com", "relaxed");
    await setSiteMode("app.example.com", "off");

    expect(await resolveMode("app.example.com")).toBe("off");
    expect(await resolveMode("other.example.com")).toBe("relaxed");
    expect(await resolveMode("unrelated.test")).toBe("default");
  });

  test("a rule covers every subdomain of its host", async () => {
    await setSiteMode("example.com", "off");
    expect(await resolveMode("deep.nested.example.com")).toBe("off");
  });

  test("setting default removes the rule rather than storing one", async () => {
    await setSiteMode("example.com", "off");
    expect(await loadSites()).toHaveLength(1);

    await setSiteMode("example.com", "default");
    expect(await loadSites()).toHaveLength(0);
  });

  test("a temporary exception expires on its own", async () => {
    await setSiteMode("example.com", "off", 50);
    expect(await resolveMode("example.com")).toBe("off");

    await new Promise((resolve) => setTimeout(resolve, 80));
    // Regression: expiry used to be checked only on a cold read, so a temporary
    // exception outlived its deadline for as long as the worker stayed warm.
    // Evaluated on every read now, cached or not, and with no timer involved.
    expect(await resolveMode("example.com")).toBe("default");
    expect(await loadSites()).toHaveLength(0);
  });

  test("a permanent exception has no expiry", async () => {
    await setSiteMode("example.com", "off");
    const [rule] = await loadSites();
    expect(rule?.expiresAt).toBeNull();
  });

  test("a temporary exception records when it lapses", async () => {
    const before = Date.now();
    await setSiteMode("example.com", "relaxed", 60_000);
    const [rule] = await loadSites();
    expect(rule?.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  test("re-setting a host replaces rather than duplicates its rule", async () => {
    await setSiteMode("example.com", "relaxed");
    await setSiteMode("example.com", "off");
    const sites = await loadSites();
    expect(sites).toHaveLength(1);
    expect(sites[0]?.mode).toBe("off");
  });
});
