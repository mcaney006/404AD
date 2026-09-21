import type { Subscription } from "./protocol";

/**
 * Remote filter-list subscriptions.
 *
 * Subscriptions are **data only**. A list is fetched as text, parsed by the
 * same Rust parser the bundled lists use, and lowered to dynamic
 * `declarativeNetRequest` rules plus a cosmetic index. Nothing in a subscription
 * is executed, and no filter syntax 404AD supports can express execution: there
 * is no include directive, no script directive and no remote resource
 * reference. That is what keeps remote subscriptions compatible with MV3's ban
 * on remote code.
 *
 * Refresh is deliberately pull-based. There is no alarm and no periodic wakeup:
 * lists refresh on worker start and when the user asks, and a list is only
 * considered stale after {@link STALE_AFTER_MS}. Waking a service worker on a
 * timer to re-download a file nobody is looking at is exactly the kind of cost
 * this design is trying not to pay.
 */

const META_KEY = "subscriptions";
const TEXT_PREFIX = "subscription:";

/** Refuse anything larger than this. A filter list is text, not a payload. */
export const MAX_LIST_BYTES = 8 * 1024 * 1024;

/** A list older than this is offered for refresh; it is never forced. */
export const STALE_AFTER_MS = 4 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 20_000;

export class SubscriptionError extends Error {}

/** Stable id for a URL, so the same list added twice collapses to one entry. */
export function subscriptionId(url: string): string {
  // FNV-1a over the normalized URL. This is an identity, not a digest: it only
  // has to be stable and collision-free across a handful of user-added lists.
  let hash = 0x811c_9dc5;
  const normalized = url.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Only `https:` and `http:` are accepted.
 *
 * A `chrome-extension:`, `data:` or `file:` URL would let a subscription reach
 * inside the extension or the local disk, which is not what subscribing to a
 * filter list means.
 */
export function assertFetchableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SubscriptionError(`not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SubscriptionError(`unsupported scheme ${parsed.protocol} (use http or https)`);
  }
  return parsed;
}

export async function loadSubscriptions(): Promise<Subscription[]> {
  const stored = await chrome.storage.local.get(META_KEY);
  return (stored[META_KEY] as Subscription[] | undefined) ?? [];
}

async function saveSubscriptions(list: Subscription[]): Promise<void> {
  const sorted = [...list].sort((a, b) => a.title.localeCompare(b.title));
  await chrome.storage.local.set({ [META_KEY]: sorted });
}

export async function subscriptionText(id: string): Promise<string> {
  const key = `${TEXT_PREFIX}${id}`;
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as string | undefined) ?? "";
}

/** Concatenated text of every enabled subscription, oldest first. */
export async function enabledSubscriptionText(): Promise<string> {
  const subscriptions = await loadSubscriptions();
  const parts: string[] = [];
  for (const subscription of subscriptions) {
    if (!subscription.enabled) continue;
    const text = await subscriptionText(subscription.id);
    if (text) parts.push(`! source: ${subscription.title}\n${text}`);
  }
  return parts.join("\n");
}

/**
 * Fetch a list and store its text.
 *
 * Returns the metadata, including any error. A failed refresh never removes the
 * previously stored text: a subscription that cannot be reached today should
 * keep working with yesterday's rules.
 */
export async function fetchSubscription(
  url: string,
  existing?: Subscription,
): Promise<Subscription> {
  const parsed = assertFetchableUrl(url);
  const id = existing?.id ?? subscriptionId(parsed.href);
  const now = Date.now();

  const base: Subscription = existing ?? {
    id,
    url: parsed.href,
    title: parsed.hostname + parsed.pathname,
    enabled: true,
    addedAt: now,
    updatedAt: 0,
    networkRules: 0,
    cosmeticRules: 0,
    bytes: 0,
    error: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(parsed.href, {
      signal: controller.signal,
      // A filter list is public data. Sending cookies to a third-party host on
      // the user's behalf is not part of subscribing to one.
      credentials: "omit",
      redirect: "follow",
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new SubscriptionError(`${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (text.length > MAX_LIST_BYTES) {
      throw new SubscriptionError(
        `list is ${Math.round(text.length / 1024)} KB, over the ${MAX_LIST_BYTES / 1024 / 1024} MB limit`,
      );
    }

    await chrome.storage.local.set({ [`${TEXT_PREFIX}${id}`]: text });
    return {
      ...base,
      url: parsed.href,
      title: titleOf(text) ?? base.title,
      updatedAt: now,
      bytes: text.length,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, error: controller.signal.aborted ? "timed out" : message };
  } finally {
    clearTimeout(timer);
  }
}

/** `! Title: EasyList` — the convention every major list follows. */
function titleOf(text: string): string | null {
  for (const line of text.slice(0, 4_000).split("\n")) {
    const match = /^!\s*Title:\s*(.+?)\s*$/i.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

export async function addSubscription(url: string): Promise<Subscription[]> {
  const parsed = assertFetchableUrl(url);
  const subscriptions = await loadSubscriptions();
  const id = subscriptionId(parsed.href);
  if (subscriptions.some((s) => s.id === id)) {
    throw new SubscriptionError("already subscribed to that list");
  }

  const fetched = await fetchSubscription(parsed.href);
  await saveSubscriptions([...subscriptions, fetched]);
  return loadSubscriptions();
}

export async function removeSubscription(id: string): Promise<Subscription[]> {
  const subscriptions = await loadSubscriptions();
  await saveSubscriptions(subscriptions.filter((s) => s.id !== id));
  await chrome.storage.local.remove(`${TEXT_PREFIX}${id}`);
  return loadSubscriptions();
}

export async function setSubscriptionEnabled(
  id: string,
  enabled: boolean,
): Promise<Subscription[]> {
  const subscriptions = await loadSubscriptions();
  await saveSubscriptions(subscriptions.map((s) => (s.id === id ? { ...s, enabled } : s)));
  return loadSubscriptions();
}

/** Refresh one subscription, or every stale one when no id is given. */
export async function refreshSubscriptions(id?: string): Promise<Subscription[]> {
  const subscriptions = await loadSubscriptions();
  const now = Date.now();

  const updated = await Promise.all(
    subscriptions.map(async (subscription) => {
      const wanted = id ? subscription.id === id : now - subscription.updatedAt > STALE_AFTER_MS;
      if (!wanted) return subscription;
      return fetchSubscription(subscription.url, subscription);
    }),
  );
  await saveSubscriptions(updated);
  return loadSubscriptions();
}

/** Record what the compiler made of a subscription, for the options page. */
export async function recordCounts(
  counts: Map<string, { networkRules: number; cosmeticRules: number }>,
): Promise<void> {
  if (counts.size === 0) return;
  const subscriptions = await loadSubscriptions();
  await saveSubscriptions(
    subscriptions.map((s) => {
      const count = counts.get(s.id);
      return count ? { ...s, ...count } : s;
    }),
  );
}
