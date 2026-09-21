import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetChromeStorage } from "../../../../tests/setup";
import {
  MAX_LIST_BYTES,
  SubscriptionError,
  addSubscription,
  assertFetchableUrl,
  enabledSubscriptionText,
  fetchSubscription,
  loadSubscriptions,
  removeSubscription,
  setSubscriptionEnabled,
  subscriptionId,
  subscriptionText,
} from "./subscriptions";

const realFetch = globalThis.fetch;

/**
 * Replace `fetch`.
 *
 * Assigned through an index signature because `typeof fetch` carries
 * runtime-specific extras that a stub has no business reproducing.
 */
function stubFetch(body: string, init: ResponseInit = {}): void {
  (globalThis as unknown as Record<string, unknown>).fetch = async () =>
    new Response(body, { status: 200, ...init });
}

function stubStatus(status: number): void {
  (globalThis as unknown as Record<string, unknown>).fetch = async () =>
    new Response("nope", { status });
}

beforeEach(() => {
  resetChromeStorage();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("URL validation", () => {
  test("accepts http and https", () => {
    expect(assertFetchableUrl("https://example.test/list.txt").protocol).toBe("https:");
    expect(assertFetchableUrl("http://example.test/list.txt").protocol).toBe("http:");
  });

  test("rejects schemes that would reach inside the extension or the disk", () => {
    // A subscription is a remote text file. Anything else is a different thing
    // wearing the same word.
    for (const url of [
      "file:///etc/passwd",
      "chrome-extension://abc/generated/diagnostics.json",
      "data:text/plain,||evil.example^",
      "javascript:alert(1)",
    ]) {
      expect(() => assertFetchableUrl(url)).toThrow(SubscriptionError);
    }
  });

  test("rejects text that is not a URL at all", () => {
    expect(() => assertFetchableUrl("not a url")).toThrow(SubscriptionError);
  });
});

describe("subscriptionId", () => {
  test("is stable and case-insensitive", () => {
    expect(subscriptionId("https://a.test/l.txt")).toBe(subscriptionId("https://A.test/L.txt"));
  });

  test("differs between lists", () => {
    expect(subscriptionId("https://a.test/l.txt")).not.toBe(subscriptionId("https://b.test/l.txt"));
  });
});

describe("fetching", () => {
  test("stores the text and takes the title from the list header", async () => {
    stubFetch("[Adblock Plus 2.0]\n! Title: Example List\n||ads.test^\n");
    const subscription = await fetchSubscription("https://example.test/list.txt");

    expect(subscription.error).toBeNull();
    expect(subscription.title).toBe("Example List");
    expect(subscription.bytes).toBeGreaterThan(0);
    expect(await subscriptionText(subscription.id)).toContain("||ads.test^");
  });

  test("falls back to the URL when the list has no title", async () => {
    stubFetch("||ads.test^\n");
    const subscription = await fetchSubscription("https://example.test/plain.txt");
    expect(subscription.title).toBe("example.test/plain.txt");
  });

  test("records an HTTP failure without losing the previous text", async () => {
    stubFetch("! Title: Good\n||ads.test^");
    const first = await fetchSubscription("https://example.test/list.txt");

    stubStatus(503);
    const second = await fetchSubscription("https://example.test/list.txt", first);

    expect(second.error).toContain("503");
    // A list that cannot be reached today keeps working with yesterday's rules.
    expect(await subscriptionText(second.id)).toContain("||ads.test^");
  });

  test("refuses a list larger than the size ceiling", async () => {
    stubFetch("x".repeat(MAX_LIST_BYTES + 1));
    const subscription = await fetchSubscription("https://example.test/huge.txt");
    expect(subscription.error).toContain("limit");
  });
});

describe("subscription lifecycle", () => {
  test("adds, disables and removes", async () => {
    stubFetch("! Title: One\n||one.test^");
    await addSubscription("https://example.test/one.txt");
    let list = await loadSubscriptions();
    expect(list).toHaveLength(1);
    expect(list[0]?.enabled).toBe(true);

    list = await setSubscriptionEnabled(list[0]!.id, false);
    expect(list[0]?.enabled).toBe(false);
    // A disabled list contributes nothing, but its text is kept.
    expect(await enabledSubscriptionText()).toBe("");

    list = await removeSubscription(list[0]!.id);
    expect(list).toHaveLength(0);
  });

  test("refuses a duplicate subscription", async () => {
    stubFetch("! Title: One\n||one.test^");
    await addSubscription("https://example.test/one.txt");
    await expect(addSubscription("https://example.test/one.txt")).rejects.toThrow(
      SubscriptionError,
    );
  });

  test("concatenates every enabled list for compilation", async () => {
    stubFetch("! Title: One\n||one.test^");
    await addSubscription("https://example.test/one.txt");
    stubFetch("! Title: Two\n||two.test^");
    await addSubscription("https://example.test/two.txt");

    const text = await enabledSubscriptionText();
    expect(text).toContain("||one.test^");
    expect(text).toContain("||two.test^");
  });

  test("removing a list also drops its stored text", async () => {
    stubFetch("! Title: One\n||one.test^");
    const [first] = await addSubscription("https://example.test/one.txt");
    await removeSubscription(first!.id);
    expect(await subscriptionText(first!.id)).toBe("");
  });
});
