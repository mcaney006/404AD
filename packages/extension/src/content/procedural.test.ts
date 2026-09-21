import { beforeEach, describe, expect, test } from "bun:test";
import { ProceduralEngine, evaluate } from "./procedural";
import type { ProceduralEntry } from "../core/protocol";

function entry(partial: Partial<ProceduralEntry>): ProceduralEntry {
  return { ruleId: 1, prefix: null, ops: [], shadow: false, ...partial };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("procedural selectors", () => {
  test(":has-text matches on visible text", () => {
    document.body.innerHTML = `
      <div class="item"><span>Sponsored</span></div>
      <div class="item"><span>Real article</span></div>`;
    const found = evaluate(
      entry({ prefix: "div.item", ops: [{ HasText: { needle: "Sponsored", regex: false } }] }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent).toContain("Sponsored");
  });

  test(":has-text accepts a regular expression", () => {
    document.body.innerHTML = `<p class="x">Ad 12</p><p class="x">Ad</p>`;
    const found = evaluate(
      entry({ prefix: "p.x", ops: [{ HasText: { needle: "^Ad \\d+$", regex: true } }] }),
    );
    expect(found).toHaveLength(1);
  });

  test("an invalid regex selects nothing rather than throwing", () => {
    document.body.innerHTML = `<p class="x">anything</p>`;
    expect(
      evaluate(entry({ prefix: "p.x", ops: [{ HasText: { needle: "([", regex: true } }] })),
    ).toEqual([]);
  });

  test(":has matches on a descendant", () => {
    document.body.innerHTML = `
      <div class="card"><img class="promo" /></div>
      <div class="card"><p>text</p></div>`;
    expect(
      evaluate(entry({ prefix: "div.card", ops: [{ Has: { selector: "img.promo" } }] })),
    ).toHaveLength(1);
  });

  test(":upward(n) climbs n levels", () => {
    document.body.innerHTML = `<section id="outer"><div><span id="leaf">x</span></div></section>`;
    const found = evaluate(
      entry({ prefix: "#leaf", ops: [{ Upward: { steps: 2, selector: null } }] }),
    );
    expect(found[0]?.id).toBe("outer");
  });

  test(":upward(selector) climbs to the nearest match", () => {
    document.body.innerHTML = `<article id="a"><div><span id="leaf">x</span></div></article>`;
    const found = evaluate(
      entry({ prefix: "#leaf", ops: [{ Upward: { steps: null, selector: "article" } }] }),
    );
    expect(found[0]?.id).toBe("a");
  });

  test(":matches-attr with and without a value", () => {
    document.body.innerHTML = `<div data-ad="true"></div><div data-ad="false"></div>`;
    expect(
      evaluate(entry({ prefix: "div", ops: [{ MatchesAttr: { name: "data-ad", value: null } }] })),
    ).toHaveLength(2);
    expect(
      evaluate(
        entry({ prefix: "div", ops: [{ MatchesAttr: { name: "data-ad", value: "true" } }] }),
      ),
    ).toHaveLength(1);
  });

  test(":min-text-length filters short nodes", () => {
    document.body.innerHTML = `<p>short</p><p>${"x".repeat(60)}</p>`;
    expect(evaluate(entry({ prefix: "p", ops: [{ MinTextLength: { len: 50 } }] }))).toHaveLength(1);
  });

  test("operators compose left to right", () => {
    document.body.innerHTML = `
      <li class="row"><h3>Sponsored</h3></li>
      <li class="row"><h3>News</h3></li>`;
    const found = evaluate(
      entry({
        prefix: "h3",
        ops: [
          { HasText: { needle: "Sponsored", regex: false } },
          { Upward: { steps: null, selector: "li.row" } },
        ],
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.tagName).toBe("LI");
  });
});

describe("ProceduralEngine", () => {
  test("hides matches and does not double-count on a second pass", () => {
    document.body.innerHTML = `<div class="item">Sponsored</div>`;
    const engine = new ProceduralEngine();
    engine.setEntries([
      entry({ prefix: "div.item", ops: [{ HasText: { needle: "Sponsored", regex: false } }] }),
    ]);

    expect(engine.run()).toBe(1);
    const el = document.querySelector("div.item") as HTMLElement;
    expect(el.style.display).toBe("none");

    expect(engine.run()).toBe(0);
    expect(engine.hiddenCount).toBe(1);
  });

  test("shadow entries are never applied", () => {
    document.body.innerHTML = `<div class="item">Sponsored</div>`;
    const engine = new ProceduralEngine();
    engine.setEntries([
      entry({
        shadow: true,
        prefix: "div.item",
        ops: [{ HasText: { needle: "Sponsored", regex: false } }],
      }),
    ]);
    expect(engine.isEmpty).toBe(true);
    expect(engine.run()).toBe(0);
    expect((document.querySelector("div.item") as HTMLElement).style.display).toBe("");
  });

  test("reset restores every element it hid", () => {
    document.body.innerHTML = `<div class="item">Sponsored</div>`;
    const engine = new ProceduralEngine();
    engine.setEntries([
      entry({ prefix: "div.item", ops: [{ HasText: { needle: "Sponsored", regex: false } }] }),
    ]);
    engine.run();
    engine.reset();

    const el = document.querySelector("div.item") as HTMLElement;
    expect(el.style.display).toBe("");
    expect(el.hasAttribute("data-404ad-hidden")).toBe(false);
    expect(engine.hiddenCount).toBe(0);
  });
});
