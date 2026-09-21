import type { CosmeticHit } from "../core/protocol";
/**
 * Cosmetic filtering in the content script.
 *
 * The expensive half of cosmetic filtering is deciding *which* of ~50k generic
 * selectors could possibly match a document. That decision happens in WASM in
 * the service worker; this file's job is to feed it the tokens it needs and to
 * apply what comes back.
 *
 * The flow is deliberately two-phase:
 *
 *  * At `document_start` the DOM is empty, so only host-specific rules can be
 *    applied. They go in immediately, before the page paints, which is what
 *    prevents the flash of an ad slot that later disappears.
 *  * Once content exists, the class and id tokens in the document are harvested
 *    and sent back for generic selection. New tokens introduced later by the
 *    page trigger an incremental round.
 */

const STYLE_ID = "404ad-cosmetic";
const HIDE_DECLARATION = "display:none!important";

/** Cap the token set so a pathological page cannot produce an unbounded message. */
const MAX_TOKENS = 20_000;

function isElement(node: ParentNode): node is Element {
  return node.nodeType === 1; /* Node.ELEMENT_NODE */
}

export class CosmeticInjector {
  private style: HTMLStyleElement | null = null;
  private readonly applied = new Set<string>();
  private readonly seenTokens = new Set<string>();

  /** Selectors currently hidden, used for the on-page count. */
  get selectorCount(): number {
    return this.applied.size;
  }

  /**
   * Add selectors to the injected stylesheet.
   *
   * One rule per selector rather than one grouped rule: an invalid selector in
   * a grouped rule invalidates every selector alongside it, so a single bad
   * filter would silently disable a whole batch.
   */
  hide(selectors: string[]): number {
    const fresh = selectors.filter((s) => s && !this.applied.has(s));
    if (fresh.length === 0) return 0;
    for (const s of fresh) this.applied.add(s);

    const css = fresh.map((s) => `${s}{${HIDE_DECLARATION}}`).join("\n");
    this.append(css);
    return fresh.length;
  }

  /** Add raw `selector { declarations }` rules from `#$#` filters. */
  addStyleRules(rules: string[]): void {
    const fresh = rules.filter((r) => r && !this.applied.has(r));
    if (fresh.length === 0) return;
    for (const r of fresh) this.applied.add(r);
    this.append(fresh.join("\n"));
  }

  private append(css: string): void {
    if (!this.style || !this.style.isConnected) {
      this.style = document.createElement("style");
      this.style.id = STYLE_ID;
      this.style.setAttribute("type", "text/css");
      // `documentElement` exists at document_start; `head` does not.
      (document.head ?? document.documentElement).append(this.style);
    }
    this.style.append(document.createTextNode(`${css}\n`));
  }

  /** Remove everything this injector added. Used when a site is disabled. */
  reset(): void {
    this.style?.remove();
    this.style = null;
    this.applied.clear();
  }

  /**
   * Collect `.class` and `#id` tokens that have not been reported yet.
   *
   * Only the delta is returned: on a busy page the same few hundred tokens
   * recur constantly, and re-sending them would turn a cheap incremental pass
   * into a per-mutation round trip.
   */
  harvestTokens(root: ParentNode = document): string[] {
    if (this.seenTokens.size >= MAX_TOKENS) return [];
    const fresh: string[] = [];

    const consider = (token: string): void => {
      if (this.seenTokens.has(token) || this.seenTokens.size >= MAX_TOKENS) return;
      this.seenTokens.add(token);
      fresh.push(token);
    };

    const scan = (element: Element): void => {
      const id = element.id;
      if (id) consider(`#${id}`);
      const className = element.getAttribute("class");
      if (!className) return;
      for (const part of className.split(/\s+/)) {
        if (part) consider(`.${part}`);
      }
    };

    // `querySelectorAll` searches descendants only. When a MutationObserver
    // hands us a freshly inserted node, that node *is* the interesting one:
    // skipping it meant an ad injected as a single leaf element was never
    // matched against a generic rule.
    if (isElement(root)) scan(root);
    for (const element of root.querySelectorAll("[class],[id]")) scan(element);
    return fresh;
  }

  /**
   * Which selectors are matching, and how many elements each one hides.
   *
   * Counting per selector rather than in aggregate is what lets the popup
   * answer "what hid that?" instead of only "how many things vanished".
   */
  hits(): CosmeticHit[] {
    const out: CosmeticHit[] = [];
    for (const selector of this.applied) {
      // Style rules are not selectors; skip anything with a declaration block.
      if (selector.includes("{")) continue;
      try {
        const count = document.querySelectorAll(selector).length;
        if (count > 0) out.push({ selector, count, procedural: false });
      } catch {
        // A filter list can contain a selector this browser rejects.
      }
    }
    return out;
  }

  /** How many elements the injected selectors match right now. */
  countHidden(): number {
    return this.hits().reduce((sum, hit) => sum + hit.count, 0);
  }
}
