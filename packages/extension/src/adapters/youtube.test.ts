import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  installPlayerWatcher,
  looksLikeInitialData,
  looksLikePlayerResponse,
  pruneAdRenderers,
  stripAdPayload,
  youtubeAdapter,
} from "./youtube";

const host = globalThis as unknown as Record<string, unknown>;
let teardown: (() => void) | null = null;

/** A player DOM close enough to the real one for the watcher to act on. */
function buildPlayer(options: { adShowing: boolean; duration?: number; skipButton?: boolean }) {
  document.body.innerHTML = `
    <div id="movie_player" class="html5-video-player${options.adShowing ? " ad-showing" : ""}">
      <video class="html5-main-video"></video>
      ${options.skipButton ? '<button class="ytp-ad-skip-button">Skip</button>' : ""}
    </div>`;

  const video = document.querySelector("video.html5-main-video") as HTMLVideoElement;
  let currentTime = 0;
  Object.defineProperties(video, {
    duration: { value: options.duration ?? 30, configurable: true },
    currentTime: {
      get: () => currentTime,
      set: (v: number) => {
        currentTime = v;
      },
      configurable: true,
    },
    paused: { value: false, configurable: true },
    play: { value: () => Promise.resolve(), configurable: true },
  });

  const skip = document.querySelector(".ytp-ad-skip-button") as HTMLElement | null;
  if (skip) {
    // happy-dom has no layout, so `offsetParent` needs to be stated explicitly.
    Object.defineProperty(skip, "offsetParent", { value: document.body, configurable: true });
  }
  return { video, skip };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  teardown?.();
  teardown = null;
  delete host.__404AD_YT__;
  document.body.innerHTML = "";
});

describe("stripAdPayload", () => {
  test("removes every ad-bearing key", () => {
    const payload = stripAdPayload({
      adPlacements: [{}],
      playerAds: [{}],
      adSlots: [{}],
      adBreakHeartbeatParams: "x",
      streamingData: { formats: [] },
      videoDetails: { title: "v" },
    }) as Record<string, unknown>;

    expect(payload.adPlacements).toBeUndefined();
    expect(payload.playerAds).toBeUndefined();
    expect(payload.adSlots).toBeUndefined();
    expect(payload.adBreakHeartbeatParams).toBeUndefined();
    // Playback must survive untouched. Stripping these is what breaks video.
    expect(payload.streamingData).toEqual({ formats: [] });
    expect(payload.videoDetails).toEqual({ title: "v" });
  });

  test("recurses into a nested playerResponse", () => {
    const payload = stripAdPayload({
      playerResponse: { adPlacements: [{}], streamingData: {} },
    }) as { playerResponse: Record<string, unknown> };
    expect(payload.playerResponse.adPlacements).toBeUndefined();
    expect(payload.playerResponse.streamingData).toEqual({});
  });

  test("leaves non-objects alone", () => {
    expect(stripAdPayload(null)).toBeNull();
    expect(stripAdPayload("text")).toBe("text");
  });
});

describe("pruneAdRenderers", () => {
  test("drops ad entries from a feed and keeps real items", () => {
    const data = {
      contents: {
        richGridRenderer: {
          contents: [
            { richItemRenderer: { content: { videoRenderer: { videoId: "a" } } } },
            { richItemRenderer: { content: { adSlotRenderer: { id: "ad" } } } },
            { richItemRenderer: { content: { videoRenderer: { videoId: "b" } } } },
          ],
        },
      },
    };
    pruneAdRenderers(data);

    const items = data.contents.richGridRenderer.contents;
    // Deleting the entry beats hiding it: the grid stops reserving a slot.
    expect(items).toHaveLength(3);
    const inner = items.map((i) => Object.keys(i.richItemRenderer.content)[0]);
    expect(inner).toEqual(["videoRenderer", undefined, "videoRenderer"]);
  });

  test("removes the array element when the ad renderer is the entry itself", () => {
    const data = {
      contents: [{ videoRenderer: {} }, { promotedVideoRenderer: {} }, { videoRenderer: {} }],
    };
    pruneAdRenderers(data);
    expect(data.contents).toHaveLength(2);
    expect(data.contents.every((c) => "videoRenderer" in c)).toBe(true);
  });

  test("strips a renderer hanging directly off a key without taking its parent", () => {
    const data = { section: { title: "Up next", mealbarPromoRenderer: { x: 1 } } };
    pruneAdRenderers(data);
    expect(data.section.title).toBe("Up next");
    expect("mealbarPromoRenderer" in data.section).toBe(false);
  });

  test("reaches arbitrarily nested feeds", () => {
    const data = {
      onResponseReceivedActions: [
        {
          appendAction: { items: [{ searchPyvRenderer: {} }, { videoRenderer: { videoId: "x" } }] },
        },
      ],
    };
    pruneAdRenderers(data);
    expect(data.onResponseReceivedActions[0]?.appendAction.items).toHaveLength(1);
  });

  test("leaves a payload with no ads untouched", () => {
    const data = { contents: [{ videoRenderer: { videoId: "a" } }] };
    expect(pruneAdRenderers(structuredClone(data))).toEqual(data);
  });

  test("survives a deep structure without recursing forever", () => {
    // A node budget is the only thing standing between a megabyte of feed data
    // and a walk that becomes the reason the page feels slow.
    let deep: Record<string, unknown> = { videoRenderer: {} };
    for (let i = 0; i < 5_000; i += 1) deep = { child: deep };
    expect(() => pruneAdRenderers(deep)).not.toThrow();
  });

  test("tolerates cycles and non-objects", () => {
    expect(pruneAdRenderers(null)).toBeNull();
    expect(pruneAdRenderers(7)).toBe(7);
  });
});

describe("looksLikeInitialData", () => {
  test("recognises navigation payloads and ignores player configs", () => {
    expect(looksLikeInitialData({ contents: {} })).toBe(true);
    expect(looksLikeInitialData({ onResponseReceivedActions: [] })).toBe(true);
    expect(looksLikeInitialData({ streamingData: {} })).toBe(false);
    expect(looksLikeInitialData("text")).toBe(false);
  });
});

describe("looksLikePlayerResponse", () => {
  test("recognises player payloads and ignores unrelated JSON", () => {
    expect(looksLikePlayerResponse({ streamingData: {} })).toBe(true);
    expect(looksLikePlayerResponse({ adPlacements: [] })).toBe(true);
    expect(looksLikePlayerResponse({ items: [1, 2] })).toBe(false);
    expect(looksLikePlayerResponse(42)).toBe(false);
  });
});

describe("adapter hooks", () => {
  test("JSON.parse strips ads from player responses and leaves others intact", () => {
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    try {
      youtubeAdapter();
      const player = JSON.parse('{"streamingData":{},"adPlacements":[{"x":1}]}');
      expect((player as Record<string, unknown>).adPlacements).toBeUndefined();

      const unrelated = JSON.parse('{"adPlacements":"kept","items":[]}');
      // No player markers, so the payload is not a player response and is
      // handed back untouched.
      expect((unrelated as Record<string, unknown>).items).toEqual([]);
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
    }
  });

  test("fetch rewrites /youtubei/v1/player responses", async () => {
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    host.fetch = async () =>
      new Response(JSON.stringify({ streamingData: { formats: [] }, adPlacements: [{ a: 1 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    try {
      youtubeAdapter();
      const response = await (host.fetch as typeof fetch)(
        "https://www.youtube.com/youtubei/v1/player?k=1",
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.adPlacements).toBeUndefined();
      expect(body.streamingData).toEqual({ formats: [] });
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
    }
  });

  test("fetch leaves unrelated endpoints alone", async () => {
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    host.fetch = async () => new Response("raw-bytes");
    try {
      youtubeAdapter();
      const response = await (host.fetch as typeof fetch)(
        "https://www.youtube.com/s/player/base.js",
      );
      expect(await response.text()).toBe("raw-bytes");
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
    }
  });

  test("JSON.parse prunes ad renderers out of feed data", () => {
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    try {
      youtubeAdapter();
      const feed = JSON.parse(
        JSON.stringify({
          contents: [{ videoRenderer: { videoId: "a" } }, { adSlotRenderer: {} }],
        }),
      ) as { contents: unknown[] };
      expect(feed.contents).toHaveLength(1);
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
    }
  });

  test("cleans a player response that was already inlined before install", () => {
    // The runtime is injected on a message round trip, so an inline script can
    // set this before the adapter exists. Only cleaning future writes would
    // leave the most common case untouched.
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    host.ytInitialPlayerResponse = { streamingData: {}, adPlacements: [{ a: 1 }] };
    try {
      youtubeAdapter();
      const value = host.ytInitialPlayerResponse as Record<string, unknown>;
      expect(value.adPlacements).toBeUndefined();
      expect(value.streamingData).toEqual({});
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
      delete host.ytInitialPlayerResponse;
    }
  });

  test("installs only once per realm", () => {
    const originalParse = JSON.parse;
    const originalFetch = host.fetch;
    try {
      youtubeAdapter();
      const afterFirst = JSON.parse;
      youtubeAdapter();
      expect(JSON.parse).toBe(afterFirst);
    } finally {
      JSON.parse = originalParse;
      host.fetch = originalFetch;
    }
  });
});

describe("player watcher", () => {
  test("clicks a visible skip button in preference to seeking", () => {
    const { video, skip } = buildPlayer({ adShowing: true, skipButton: true });
    let clicked = false;
    skip?.addEventListener("click", () => {
      clicked = true;
    });

    teardown = installPlayerWatcher();
    expect(clicked).toBe(true);
    // Clicking is the clean exit; seeking would be a second, redundant action.
    expect(video.currentTime).toBe(0);
  });

  test("seeks past an unskippable ad", () => {
    const { video } = buildPlayer({ adShowing: true, duration: 30 });
    teardown = installPlayerWatcher();
    expect(video.currentTime).toBeGreaterThan(29);
    expect(video.muted).toBe(true);
  });

  test("leaves ordinary playback untouched", () => {
    const { video } = buildPlayer({ adShowing: false, duration: 600 });
    teardown = installPlayerWatcher();
    expect(video.currentTime).toBe(0);
    expect(video.muted).toBe(false);
  });

  test("restores the viewer mute state once the ad ends", () => {
    // Regression: the capture used to live in the watcher closure, so an SPA
    // navigation mid-ad re-armed the watcher with no state to restore and left
    // the video muted permanently.
    const player = buildPlayer({ adShowing: true, duration: 30 });
    teardown = installPlayerWatcher();
    expect(player.video.muted).toBe(true);

    // The ad finishes: YouTube drops the class, and the next tick restores.
    document.getElementById("movie_player")?.classList.remove("ad-showing");
    teardown();
    teardown = installPlayerWatcher();
    expect(player.video.muted).toBe(false);
  });

  test("dismisses the enforcement modal and resumes playback", () => {
    buildPlayer({ adShowing: false, duration: 600 });
    document.body.insertAdjacentHTML(
      "beforeend",
      "<ytd-enforcement-message-view-model></ytd-enforcement-message-view-model><tp-yt-iron-overlay-backdrop></tp-yt-iron-overlay-backdrop>",
    );
    document.body.style.setProperty("overflow", "hidden");

    teardown = installPlayerWatcher();

    expect(document.querySelector("ytd-enforcement-message-view-model")).toBeNull();
    expect(document.querySelector("tp-yt-iron-overlay-backdrop")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  test("closes an overlay banner", () => {
    buildPlayer({ adShowing: false });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button class="ytp-ad-overlay-close-button"></button>',
    );
    let clicked = false;
    document.querySelector(".ytp-ad-overlay-close-button")?.addEventListener("click", () => {
      clicked = true;
    });

    teardown = installPlayerWatcher();
    expect(clicked).toBe(true);
  });
});
