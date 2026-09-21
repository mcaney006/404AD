import { beforeEach, describe, expect, test } from "bun:test";
import { CosmeticInjector } from "./cosmetic";

beforeEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("CosmeticInjector", () => {
  test("injects one rule per selector so one bad selector cannot poison the batch", () => {
    const injector = new CosmeticInjector();
    injector.hide([".a", ".b"]);
    const css = document.getElementById("404ad-cosmetic")?.textContent ?? "";
    expect(css).toContain(".a{display:none!important}");
    expect(css).toContain(".b{display:none!important}");
  });

  test("does not re-inject a selector it already applied", () => {
    const injector = new CosmeticInjector();
    expect(injector.hide([".a", ".b"])).toBe(2);
    expect(injector.hide([".b", ".c"])).toBe(1);
    expect(injector.selectorCount).toBe(3);
  });

  test("harvests class and id tokens", () => {
    document.body.innerHTML = `<div id="top" class="ad-banner promo"></div>`;
    const tokens = new CosmeticInjector().harvestTokens();
    expect(tokens).toContain("#top");
    expect(tokens).toContain(".ad-banner");
    expect(tokens).toContain(".promo");
  });

  test("returns only the delta, so repeat passes are cheap", () => {
    document.body.innerHTML = `<div class="a"></div>`;
    const injector = new CosmeticInjector();
    expect(injector.harvestTokens()).toEqual([".a"]);
    expect(injector.harvestTokens()).toEqual([]);

    document.body.insertAdjacentHTML("beforeend", '<div class="b"></div>');
    expect(injector.harvestTokens()).toEqual([".b"]);
  });

  test("harvests from the root element itself, not only its descendants", () => {
    // Regression: a MutationObserver hands over the inserted node. When that
    // node carries the ad class and has no children, scanning only descendants
    // found nothing and the element was never hidden.
    document.body.innerHTML = `<div class="sponsored-link" id="late"></div>`;
    const injected = document.getElementById("late") as Element;

    const tokens = new CosmeticInjector().harvestTokens(injected);
    expect(tokens).toContain(".sponsored-link");
    expect(tokens).toContain("#late");
  });

  test("counts the elements its selectors actually match", () => {
    document.body.innerHTML = `<div class="ad"></div><div class="ad"></div><div class="ok"></div>`;
    const injector = new CosmeticInjector();
    injector.hide([".ad"]);
    expect(injector.countHidden()).toBe(2);
  });

  test("a selector this browser rejects does not break the count", () => {
    document.body.innerHTML = `<div class="ad"></div>`;
    const injector = new CosmeticInjector();
    injector.hide([".ad", ":::nonsense"]);
    expect(injector.countHidden()).toBe(1);
  });

  test("reset removes the stylesheet entirely", () => {
    const injector = new CosmeticInjector();
    injector.hide([".a"]);
    injector.reset();
    expect(document.getElementById("404ad-cosmetic")).toBeNull();
    expect(injector.selectorCount).toBe(0);
  });

  test("style rules are injected verbatim", () => {
    const injector = new CosmeticInjector();
    injector.addStyleRules([".rail { display: none !important; }"]);
    expect(document.getElementById("404ad-cosmetic")?.textContent).toContain(
      ".rail { display: none !important; }",
    );
  });
});
