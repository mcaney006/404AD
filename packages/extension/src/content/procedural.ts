import type { ProceduralEntry, ProceduralOp } from "../core/protocol";

/**
 * Procedural selector evaluation.
 *
 * `:has-text()`, `:upward()` and friends cannot be expressed in CSS, so they are
 * evaluated here against live elements. That makes them the most expensive part
 * of cosmetic filtering, which is why they are host-scoped at compile time and
 * why this engine is bounded on three axes:
 *
 *  * a candidate cap per rule, so a `*` prefix cannot walk a whole large DOM,
 *  * a time budget per pass, checked between rules,
 *  * idle scheduling, so a pass never competes with the page's own rendering.
 */

const MAX_CANDIDATES = 2_000;
const TIME_BUDGET_MS = 12;
const HIDDEN_ATTR = "data-404ad-hidden";

function textOf(element: Element): string {
  return (element as HTMLElement).innerText ?? element.textContent ?? "";
}

function applyOp(elements: Element[], op: ProceduralOp): Element[] {
  if ("HasText" in op) {
    const { needle, regex } = op.HasText;
    if (regex) {
      let re: RegExp;
      try {
        re = new RegExp(needle);
      } catch {
        return [];
      }
      return elements.filter((el) => re.test(textOf(el)));
    }
    return elements.filter((el) => textOf(el).includes(needle));
  }

  if ("Has" in op) {
    const selector = op.Has.selector;
    return elements.filter((el) => {
      try {
        return el.querySelector(selector) !== null;
      } catch {
        return false;
      }
    });
  }

  if ("Upward" in op) {
    const { steps, selector } = op.Upward;
    const out: Element[] = [];
    for (const el of elements) {
      if (selector) {
        const found = el.closest(selector);
        if (found) out.push(found);
        continue;
      }
      let current: Element | null = el;
      for (let i = 0; i < (steps ?? 0) && current; i += 1) {
        current = current.parentElement;
      }
      if (current) out.push(current);
    }
    return out;
  }

  if ("MatchesAttr" in op) {
    const { name, value } = op.MatchesAttr;
    return elements.filter((el) => {
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      return value === null || actual === value;
    });
  }

  if ("MinTextLength" in op) {
    const min = op.MinTextLength.len;
    return elements.filter((el) => textOf(el).length >= min);
  }

  return [];
}

/** Evaluate one rule, returning the elements it selects. */
export function evaluate(entry: ProceduralEntry, root: ParentNode = document): Element[] {
  let elements: Element[];
  try {
    elements = Array.from(root.querySelectorAll(entry.prefix ?? "*"));
  } catch {
    return [];
  }
  if (elements.length > MAX_CANDIDATES) elements = elements.slice(0, MAX_CANDIDATES);

  for (const op of entry.ops) {
    elements = applyOp(elements, op);
    if (elements.length === 0) break;
  }
  return elements;
}

export class ProceduralEngine {
  private entries: ProceduralEntry[] = [];
  private hidden = 0;
  private scheduled = false;

  get hiddenCount(): number {
    return this.hidden;
  }

  setEntries(entries: ProceduralEntry[]): void {
    this.entries = entries.filter((e) => !e.shadow);
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Coalesce bursts of mutations into one idle-time pass. */
  schedule(): void {
    if (this.scheduled || this.entries.length === 0) return;
    this.scheduled = true;
    const run = (): void => {
      this.scheduled = false;
      this.run();
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run, { timeout: 500 });
    } else {
      setTimeout(run, 100);
    }
  }

  run(): number {
    const started = performance.now();
    let newlyHidden = 0;

    for (const entry of this.entries) {
      if (performance.now() - started > TIME_BUDGET_MS) break;
      for (const element of evaluate(entry)) {
        if (element.hasAttribute(HIDDEN_ATTR)) continue;
        element.setAttribute(HIDDEN_ATTR, String(entry.ruleId));
        (element as HTMLElement).style.setProperty("display", "none", "important");
        newlyHidden += 1;
      }
    }
    this.hidden += newlyHidden;
    return newlyHidden;
  }

  /** Undo every hide, for when a site is switched to relaxed or off. */
  reset(): void {
    for (const element of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
      (element as HTMLElement).style.removeProperty("display");
      element.removeAttribute(HIDDEN_ATTR);
    }
    this.hidden = 0;
  }
}
