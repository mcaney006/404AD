/**
 * The YouTube runtime adapter.
 *
 * YouTube does not deliver its video ads as separate, blockable requests. The
 * ad manifest arrives inside the same `/youtubei/v1/player` response that
 * carries the playback configuration, and the player reads it from an in-page
 * object. Blocking that request does not remove the ad, it removes the video.
 *
 * So this adapter works at the only layer where the distinction exists: the
 * page's own realm. Three cooperating parts, in order of how much they matter:
 *
 *  1. **Payload stripping.** Remove `adPlacements`, `playerAds` and `adSlots`
 *     from every player response before the player ever sees them, whether it
 *     arrives via `JSON.parse`, via `fetch`, or as the inlined
 *     `ytInitialPlayerResponse` global.
 *  2. **Player state machine.** When an ad slips through anyway, the player
 *     marks itself `.ad-showing`. Seek past it, click the skip control the
 *     moment it becomes interactive, and restore the user's volume and playback
 *     rate afterwards.
 *  3. **Enforcement modal.** Dismiss the "ad blockers violate YouTube's Terms"
 *     interstitial and resume playback, because it pauses the video.
 *
 * The adapter is SPA-aware: YouTube never reloads, so everything re-arms on
 * `yt-navigate-finish` and tears down on `pagehide`.
 */

import { fetchUrl, patchFetchWith } from "../scriptlets/library";

/**
 * Which YouTube surface the page is currently showing.
 *
 * YouTube is one SPA wearing several very different shapes. The watch page, a
 * Shorts reel, YouTube Music and an embed each use a different player element
 * and a different ad shape, and a single `#movie_player` assumption silently
 * does nothing on three of them.
 */
export type Surface =
  | "watch"
  | "shorts"
  | "search"
  | "home"
  | "channel"
  | "playlist"
  | "music"
  | "embed"
  | "other";

export function detectSurface(href: string): Surface {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "other";
  }
  const { hostname, pathname } = url;

  if (hostname.endsWith("youtube-nocookie.com") || pathname.startsWith("/embed/")) {
    return "embed";
  }
  if (hostname.startsWith("music.")) return "music";
  if (pathname.startsWith("/shorts/")) return "shorts";
  if (pathname === "/watch") return "watch";
  if (pathname === "/results") return "search";
  if (pathname === "/playlist") return "playlist";
  if (pathname === "/" || pathname === "/feed/subscriptions" || pathname.startsWith("/feed/")) {
    return "home";
  }
  if (pathname.startsWith("/@") || pathname.startsWith("/channel/") || pathname.startsWith("/c/")) {
    return "channel";
  }
  return "other";
}

/**
 * Player elements on this surface.
 *
 * Several can exist at once: a Shorts page keeps `#shorts-player` alongside a
 * hidden `#movie_player`, and a channel page has an inline trailer player.
 */
export function findPlayers(): HTMLElement[] {
  const selectors = [
    "#movie_player",
    "#shorts-player",
    "ytd-reel-video-renderer[is-active] #shorts-player",
    "ytmusic-player #movie_player",
    ".html5-video-player",
  ];
  const found = new Set<HTMLElement>();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      found.add(element);
    }
  }
  return [...found];
}

/** The `<video>` inside a player, or the page's only one. */
export function videoOf(player: HTMLElement | null): HTMLVideoElement | null {
  return (
    player?.querySelector<HTMLVideoElement>("video") ??
    document.querySelector<HTMLVideoElement>("video.html5-main-video")
  );
}

const AD_KEYS = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"] as const;

/**
 * Renderer types YouTube uses to represent an ad inside `ytInitialData`.
 *
 * Hiding these with CSS works, but leaves the item in the data model and leaves
 * a gap where the grid still reserves space for it. Deleting the entry instead
 * makes the feed behave as though the ad was never served.
 */
const AD_RENDERERS = new Set([
  "actionCompanionAdRenderer",
  "adSlotRenderer",
  "adsEngagementPanelRenderer",
  "bannerPromoRenderer",
  "brandVideoShelfRenderer",
  "brandVideoSingletonRenderer",
  "carouselAdRenderer",
  "compactPromotedItemRenderer",
  "compactPromotedVideoRenderer",
  "displayAdRenderer",
  "inFeedAdLayoutRenderer",
  "mealbarPromoRenderer",
  "playerLegacyDesktopWatchAdsRenderer",
  "primetimePromoRenderer",
  "promotedSparklesTextSearchRenderer",
  "promotedSparklesWebRenderer",
  "promotedVideoRenderer",
  "searchPyvRenderer",
  "statementBannerRenderer",
  "videoMastheadAdV3Renderer",
]);

/**
 * `ytInitialData` is on the order of a megabyte. Walking it is worth it once
 * per navigation and never worth it unboundedly, so the walk carries a node
 * budget and stops rather than becoming the thing that makes the page slow.
 */
const PRUNE_NODE_BUDGET = 200_000;

/** Remove every ad-bearing key from a player response, in place. */
export function stripAdPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;

  for (const key of AD_KEYS) {
    if (key in record) delete record[key];
  }
  // Some responses nest the config one level down.
  for (const nested of ["playerResponse", "response"]) {
    if (record[nested] && typeof record[nested] === "object") {
      stripAdPayload(record[nested]);
    }
  }
  return value;
}

/**
 * Recursively drop array entries that are ad renderers.
 *
 * Only array elements are removed. An ad renderer always appears as one item in
 * a list of items, so deleting the element is the surgical edit; deleting the
 * key it hangs off would take the surrounding section with it.
 */
export function pruneAdRenderers(root: unknown): unknown {
  let budget = PRUNE_NODE_BUDGET;

  const isAdEntry = (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    Object.keys(value as object).some((key) => AD_RENDERERS.has(key));

  const walk = (value: unknown): void => {
    if (budget <= 0 || value === null || typeof value !== "object") return;
    budget -= 1;

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) {
        if (isAdEntry(value[i])) {
          value.splice(i, 1);
        } else {
          walk(value[i]);
        }
      }
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      // A renderer hanging directly off a key, rather than inside a list, is
      // replaced with undefined so the surrounding structure survives.
      if (AD_RENDERERS.has(key)) {
        delete record[key];
        continue;
      }
      walk(record[key]);
    }
  };

  walk(root);
  return root;
}

/** Does this payload look like the SPA's navigation data rather than a player config? */
export function looksLikeInitialData(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    "contents" in record ||
    "onResponseReceivedActions" in record ||
    "onResponseReceivedEndpoints" in record
  );
}

export function looksLikePlayerResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    "streamingData" in record ||
    "videoDetails" in record ||
    "playerResponse" in record ||
    AD_KEYS.some((key) => key in record)
  );
}

/** Part 1a: strip ads from anything the page parses as JSON. */
function patchJsonParse(): void {
  const original = JSON.parse;
  JSON.parse = function patchedParse(text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    const parsed = original.call(JSON, text, reviver);
    if (looksLikePlayerResponse(parsed)) return stripAdPayload(parsed);
    if (looksLikeInitialData(parsed)) return pruneAdRenderers(parsed);
    return parsed;
  };
}

/** Part 1b: strip ads from player responses fetched by the SPA. */
function patchFetch(): void {
  patchFetchWith(async (original, input, init) => {
    const response = await original.call(globalThis, input, init);
    const url = fetchUrl(input);
    const AD_BEARING = [
      "/youtubei/v1/player",
      "/youtubei/v1/next",
      "/youtubei/v1/browse",
      "/youtubei/v1/search",
      "/youtubei/v1/reel/reel_watch_sequence",
    ];
    if (!AD_BEARING.some((path) => url.includes(path))) {
      return response;
    }
    try {
      const clone = response.clone();
      const payload = pruneAdRenderers(stripAdPayload(await clone.json()));
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      // Not JSON, or already consumed. Hand back the untouched response rather
      // than breaking playback over a failed optimisation.
      return response;
    }
  });
}

/** Part 1c: the first player response is inlined as a global, not fetched. */
function patchInitialResponse(): void {
  const host = globalThis as unknown as Record<string, unknown>;

  for (const key of ["ytInitialPlayerResponse", "ytInitialData"]) {
    // The value may already be there. The content script injects this runtime
    // on the response to a message round trip, so an inline script near the top
    // of the document can win the race. Cleaning what is already set closes it
    // for everything except a page that reads the object in the very same
    // inline script that assigns it.
    let stored: unknown = host[key];
    if (stored !== undefined) {
      stored = pruneAdRenderers(stripAdPayload(stored));
    }

    try {
      Object.defineProperty(globalThis, key, {
        get: () => stored,
        set: (value: unknown) => {
          stored = pruneAdRenderers(stripAdPayload(value));
        },
        configurable: true,
      });
    } catch {
      // Already defined non-configurably; the JSON.parse hook still covers it.
    }
  }
}

/**
 * The enforcement interstitial pauses the video and blocks the UI. Removing it
 * without resuming playback leaves a stopped player, which reads as breakage.
 */
function dismissEnforcementModal(video: HTMLVideoElement | null): void {
  const modal = document.querySelector(
    "ytd-enforcement-message-view-model, tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)",
  );
  if (!modal) return;
  modal.remove();
  document.querySelector("tp-yt-iron-overlay-backdrop")?.remove();
  document.body.style.removeProperty("overflow");
  if (video?.paused) void video.play().catch(() => undefined);
}

/**
 * Part 2: the player state machine.
 *
 * Seeking to the end of an ad is preferred over muting-and-waiting: it returns
 * control to the user immediately instead of after the ad's duration. The
 * user's own volume and rate are captured before the first intervention and
 * restored after the last one, so a skipped ad leaves no trace in the player.
 */
/**
 * The viewer's own mute and rate, captured before the first intervention.
 *
 * Deliberately module scope, not watcher scope. The watcher is torn down and
 * re-armed on every `yt-navigate-finish`, and YouTube fires that while an ad is
 * still playing. Holding this per-watcher meant an SPA navigation mid-ad lost
 * the captured state and left the video muted for good.
 */
let restoreMuted: boolean | null = null;
let restoreRate: number | null = null;

export function installPlayerWatcher(): () => void {
  const skipSelectors = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    ".ytp-ad-survey-answer-button",
  ];
  const dismissSelectors = [
    ".ytp-ad-overlay-close-button",
    ".ytp-ad-overlay-close-container",
    ".ytp-suggested-action-badge-dismiss-button-icon",
    ".ytp-ad-visit-advertiser-button-dismiss",
  ];

  /**
   * Handle one player.
   *
   * Every surface with a player gets the same treatment, because the ad
   * mechanism is the same even when the wrapper is not. What differs is how the
   * surface is *entered*, which is why re-arming is driven by URL changes
   * rather than by any one player element's lifetime.
   */
  const handlePlayer = (player: HTMLElement): void => {
    const video = videoOf(player);
    if (!video) return;

    if (!player.classList.contains("ad-showing")) {
      if (restoreMuted !== null) {
        video.muted = restoreMuted;
        restoreMuted = null;
      }
      if (restoreRate !== null) {
        video.playbackRate = restoreRate;
        restoreRate = null;
      }
      return;
    }

    // An ad is playing. Capture the viewer's state once, on the first frame.
    if (restoreMuted === null) restoreMuted = video.muted;
    if (restoreRate === null) restoreRate = video.playbackRate;

    // A visible skip button is the cleanest exit: it tells YouTube the ad ended.
    for (const selector of skipSelectors) {
      const button =
        player.querySelector<HTMLElement>(selector) ??
        document.querySelector<HTMLElement>(selector);
      if (button && button.offsetParent !== null) {
        button.click();
        return;
      }
    }

    // Otherwise seek past it. `duration` is NaN until metadata loads.
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      if (video.currentTime < video.duration - 0.15) {
        video.currentTime = video.duration - 0.05;
      }
      if (video.paused) void video.play().catch(() => undefined);
    }
  };

  const tick = (): void => {
    // Overlay banners are dismissible whether or not a video ad is playing.
    for (const selector of dismissSelectors) {
      document.querySelector<HTMLElement>(selector)?.click();
    }

    const players = findPlayers();
    dismissEnforcementModal(videoOf(players[0] ?? null));

    for (const player of players) {
      handlePlayer(player);
    }

    // A Shorts reel whose content is an ad is removed outright; skipping is
    // meaningless when the whole item is the advertisement.
    if (detectSurface(location.href) === "shorts") {
      removeShortsAds();
    }
  };

  tick();
  const observer = new MutationObserver(tick);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "is-active", "hidden"],
  });
  // A class change inside the player does not always mutate observed nodes, so
  // back the observer with a low-frequency poll.
  const timer = setInterval(tick, 400);

  return () => {
    observer.disconnect();
    clearInterval(timer);
  };
}

/**
 * Remove advertisement reels from the Shorts feed.
 *
 * Hiding one is not enough: the reel carousel keeps it in the rotation, so the
 * viewer swipes into a blank screen. Removing the node takes it out of the
 * sequence entirely.
 */
export function removeShortsAds(): number {
  const selectors = [
    "ytd-reel-video-renderer:has(ytd-ad-slot-renderer)",
    "ytd-reel-video-renderer:has(ytd-display-ad-renderer)",
    "ytm-reel-item-renderer:has(ytm-promoted-video-renderer)",
    "ytd-reel-video-renderer:has(.ytp-ad-module)",
  ];
  let removed = 0;
  for (const selector of selectors) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const element of matches) {
      element.remove();
      removed += 1;
    }
  }
  return removed;
}

/**
 * Watch for navigation.
 *
 * `yt-navigate-finish` covers most transitions, but not all: swiping between
 * Shorts, a Music queue advance and a back-button navigation each change the
 * URL without firing it reliably. Polling `location.href` is crude and it is
 * also the only thing that catches every case, so both are used and the
 * callback is idempotent.
 */
export function watchNavigation(onNavigate: (surface: Surface) => void): () => void {
  let previous = location.href;

  const check = (): void => {
    if (location.href === previous) return;
    previous = location.href;
    onNavigate(detectSurface(location.href));
  };

  const events = ["yt-navigate-finish", "yt-page-data-updated", "popstate", "hashchange"];
  for (const event of events) globalThis.addEventListener(event, check);
  const timer = setInterval(check, 500);

  return () => {
    for (const event of events) globalThis.removeEventListener(event, check);
    clearInterval(timer);
  };
}

/** Install the adapter. Safe to call more than once. */
export function youtubeAdapter(): void {
  const flag = "__404AD_YT__";
  const host = globalThis as unknown as Record<string, unknown>;
  if (host[flag]) return;
  host[flag] = true;

  patchInitialResponse();
  patchJsonParse();
  patchFetch();

  let teardown = installPlayerWatcher();

  // YouTube is a single-page app: a "navigation" never reloads the document, so
  // the watcher has to be re-armed against the new player element.
  const stopNavigation = watchNavigation(() => {
    teardown();
    teardown = installPlayerWatcher();
  });

  globalThis.addEventListener(
    "pagehide",
    () => {
      teardown();
      stopNavigation();
    },
    { once: true },
  );
}
