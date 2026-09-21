import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  detectSurface,
  findPlayers,
  installPlayerWatcher,
  removeShortsAds,
  videoOf,
  watchNavigation,
} from "./youtube";

const host = globalThis as unknown as Record<string, unknown>;
let teardown: (() => void) | null = null;

/** Stand in for layout, which happy-dom does not do. */
function makeVideo(element: HTMLVideoElement, duration = 30): HTMLVideoElement {
  let currentTime = 0;
  Object.defineProperties(element, {
    duration: { value: duration, configurable: true },
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
  return element;
}

function visible(element: HTMLElement): HTMLElement {
  Object.defineProperty(element, "offsetParent", { value: document.body, configurable: true });
  return element;
}

/**
 * Navigate within the page's origin.
 *
 * `history` refuses a cross-origin URL, which is correct browser behaviour, so
 * the navigation tests stay on www.youtube.com. Cross-origin surfaces such as
 * music.youtube.com are covered by `detectSurface`, which is a pure function of
 * a string and needs no navigation at all.
 */
function setHref(path: string): void {
  history.replaceState(null, "", path);
}

beforeEach(() => {
  document.body.innerHTML = "";
  setHref("/");
});

afterEach(() => {
  teardown?.();
  teardown = null;
  delete host.__404AD_YT__;
  document.body.innerHTML = "";
});

describe("detectSurface", () => {
  test("recognises every surface 404AD treats differently", () => {
    const cases: Array<[string, string]> = [
      ["https://www.youtube.com/watch?v=abc", "watch"],
      ["https://m.youtube.com/watch?v=abc", "watch"],
      ["https://www.youtube.com/shorts/xyz", "shorts"],
      ["https://www.youtube.com/results?search_query=cats", "search"],
      ["https://www.youtube.com/", "home"],
      ["https://www.youtube.com/feed/subscriptions", "home"],
      ["https://www.youtube.com/@creator", "channel"],
      ["https://www.youtube.com/channel/UC123", "channel"],
      ["https://www.youtube.com/c/legacy", "channel"],
      ["https://www.youtube.com/playlist?list=PL1", "playlist"],
      ["https://music.youtube.com/watch?v=abc", "music"],
      ["https://www.youtube-nocookie.com/embed/abc", "embed"],
      ["https://www.youtube.com/embed/abc", "embed"],
      ["https://www.youtube.com/about", "other"],
    ];
    for (const [url, expected] of cases) {
      expect(detectSurface(url)).toBe(expected as never);
    }
  });

  test("an embed wins over the music host, because the player is the embed's", () => {
    expect(detectSurface("https://music.youtube.com/embed/abc")).toBe("embed");
  });

  test("a malformed URL is `other` rather than a throw", () => {
    expect(detectSurface("not a url")).toBe("other");
  });
});

describe("findPlayers", () => {
  test("finds the watch player", () => {
    document.body.innerHTML = `<div id="movie_player"><video></video></div>`;
    expect(findPlayers()).toHaveLength(1);
  });

  test("finds the Shorts player, which is a different element entirely", () => {
    // A single `#movie_player` assumption silently does nothing here.
    document.body.innerHTML = `<div id="shorts-player" class="html5-video-player"><video></video></div>`;
    const players = findPlayers();
    expect(players).toHaveLength(1);
    expect(players[0]?.id).toBe("shorts-player");
  });

  test("finds both when a Shorts page keeps a hidden watch player around", () => {
    document.body.innerHTML = `
      <div id="movie_player"><video></video></div>
      <div id="shorts-player"><video></video></div>`;
    expect(findPlayers()).toHaveLength(2);
  });

  test("finds the Music player", () => {
    document.body.innerHTML = `<ytmusic-player><div id="movie_player"><video></video></div></ytmusic-player>`;
    expect(findPlayers()).toHaveLength(1);
  });

  test("videoOf falls back to the page's main video", () => {
    document.body.innerHTML = `<div id="wrapper"></div><video class="html5-main-video"></video>`;
    expect(videoOf(document.getElementById("wrapper"))).not.toBeNull();
  });
});

describe("player handling across surfaces", () => {
  test("skips an ad in the Shorts player", () => {
    document.body.innerHTML = `
      <div id="shorts-player" class="html5-video-player ad-showing"><video></video></div>`;
    const video = makeVideo(document.querySelector("video")!, 20);

    teardown = installPlayerWatcher();
    expect(video.currentTime).toBeGreaterThan(19);
    expect(video.muted).toBe(true);
  });

  test("skips an ad in an embed", () => {
    setHref("/embed/abc");
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player ad-showing"><video></video></div>`;
    const video = makeVideo(document.querySelector("video")!, 15);

    teardown = installPlayerWatcher();
    expect(video.currentTime).toBeGreaterThan(14);
  });

  test("handles two players at once without interfering", () => {
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player"><video id="a"></video></div>
      <div id="shorts-player" class="html5-video-player ad-showing"><video id="b"></video></div>`;
    const idle = makeVideo(document.querySelector<HTMLVideoElement>("#a")!, 600);
    const advertising = makeVideo(document.querySelector<HTMLVideoElement>("#b")!, 20);

    teardown = installPlayerWatcher();
    expect(advertising.currentTime).toBeGreaterThan(19);
    expect(idle.currentTime).toBe(0);
  });

  test("prefers the skip button inside the player it belongs to", () => {
    document.body.innerHTML = `
      <div id="shorts-player" class="html5-video-player ad-showing">
        <video></video>
        <button class="ytp-ad-skip-button">Skip</button>
      </div>`;
    const video = makeVideo(document.querySelector("video")!, 20);
    const button = visible(document.querySelector<HTMLElement>(".ytp-ad-skip-button")!);
    let clicked = false;
    button.addEventListener("click", () => {
      clicked = true;
    });

    teardown = installPlayerWatcher();
    expect(clicked).toBe(true);
    expect(video.currentTime).toBe(0);
  });
});

describe("removeShortsAds", () => {
  test("removes an advertising reel from the rotation", () => {
    // Hiding is not enough: the carousel keeps a hidden reel in the sequence,
    // so the viewer swipes into a blank screen.
    document.body.innerHTML = `
      <ytd-reel-video-renderer id="real"><div>video</div></ytd-reel-video-renderer>
      <ytd-reel-video-renderer id="ad"><ytd-ad-slot-renderer></ytd-ad-slot-renderer></ytd-reel-video-renderer>`;
    expect(removeShortsAds()).toBe(1);
    expect(document.getElementById("ad")).toBeNull();
    expect(document.getElementById("real")).not.toBeNull();
  });

  test("removes a mobile promoted reel", () => {
    document.body.innerHTML = `
      <ytm-reel-item-renderer id="ad"><ytm-promoted-video-renderer></ytm-promoted-video-renderer></ytm-reel-item-renderer>`;
    expect(removeShortsAds()).toBe(1);
  });

  test("leaves an ordinary reel alone", () => {
    document.body.innerHTML = `<ytd-reel-video-renderer id="real"><video></video></ytd-reel-video-renderer>`;
    expect(removeShortsAds()).toBe(0);
    expect(document.getElementById("real")).not.toBeNull();
  });

  test("runs automatically on the Shorts surface", () => {
    setHref("/shorts/xyz");
    document.body.innerHTML = `
      <div id="shorts-player" class="html5-video-player"><video></video></div>
      <ytd-reel-video-renderer id="ad"><ytd-ad-slot-renderer></ytd-ad-slot-renderer></ytd-reel-video-renderer>`;
    makeVideo(document.querySelector("video")!, 30);

    teardown = installPlayerWatcher();
    expect(document.getElementById("ad")).toBeNull();
  });

  test("does not run on the watch surface", () => {
    setHref("/watch?v=abc");
    document.body.innerHTML = `
      <div id="movie_player" class="html5-video-player"><video></video></div>
      <ytd-reel-video-renderer id="carousel"><ytd-ad-slot-renderer></ytd-ad-slot-renderer></ytd-reel-video-renderer>`;
    makeVideo(document.querySelector("video")!, 600);

    teardown = installPlayerWatcher();
    // The CSS rule hides it here; ripping nodes out of a page that is not a
    // Shorts feed is a bigger intervention than the problem warrants.
    expect(document.getElementById("carousel")).not.toBeNull();
  });
});

describe("watchNavigation", () => {
  test("fires on a yt-navigate-finish transition", () => {
    const seen: string[] = [];
    teardown = watchNavigation((surface) => seen.push(surface));

    setHref("/watch?v=abc");
    globalThis.dispatchEvent(new Event("yt-navigate-finish"));
    expect(seen).toEqual(["watch"]);
  });

  test("fires on a history navigation that emits no custom event", () => {
    // Swiping between Shorts and the back button both do this.
    const seen: string[] = [];
    teardown = watchNavigation((surface) => seen.push(surface));

    setHref("/shorts/one");
    globalThis.dispatchEvent(new Event("popstate"));
    expect(seen).toEqual(["shorts"]);
  });

  test("does not fire when the URL has not changed", () => {
    const seen: string[] = [];
    teardown = watchNavigation((surface) => seen.push(surface));

    globalThis.dispatchEvent(new Event("yt-navigate-finish"));
    globalThis.dispatchEvent(new Event("popstate"));
    expect(seen).toEqual([]);
  });

  test("reports each distinct surface once per transition", () => {
    const seen: string[] = [];
    teardown = watchNavigation((surface) => seen.push(surface));

    for (const path of ["/watch?v=a", "/shorts/b", "/results?search_query=c"]) {
      setHref(path);
      globalThis.dispatchEvent(new Event("yt-navigate-finish"));
    }
    expect(seen).toEqual(["watch", "shorts", "search"]);
  });

  test("teardown stops further reports", () => {
    const seen: string[] = [];
    const stop = watchNavigation((surface) => seen.push(surface));
    stop();

    setHref("/watch?v=abc");
    globalThis.dispatchEvent(new Event("yt-navigate-finish"));
    expect(seen).toEqual([]);
  });
});
