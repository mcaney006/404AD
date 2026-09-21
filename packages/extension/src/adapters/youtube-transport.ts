import initTransportWasm, { TransportEngine } from "../wasm/fad_yt_wasm.js";

/**
 * YouTube transport instrumentation.
 *
 * YouTube's web client is increasingly SABR-only: audio and video arrive inside
 * UMP-framed responses rather than as ordinary segment URLs. A URL-matching
 * blocker cannot see inside that, and with server-side ad placement the ad and
 * the content can share a transport stream.
 *
 * So 404AD instruments the one place an extension can still reach:
 *
 * ```text
 * Chromium network stack
 *        │
 *       DNR                  ← peripheral requests only
 *        │
 * fetch / streaming Response
 *        │
 *   ████ 404AD HOOK ████     ← here
 *        │
 *   SABR / UMP               → Rust: framing, timeline, inference
 *        │
 *   MediaSource
 *        │
 *   SourceBuffer.appendBuffer  ← fallback gate
 * ```
 *
 * Three defences, in order of preference:
 *
 * 1. **Payload surgery** (`youtube.ts`) removes ad placements before the player
 *    initialises. Cheapest and safest.
 * 2. **Transport classification** (this file) recognises an advertising media
 *    epoch from the stream itself and seeks past it.
 * 3. **MediaSource gate** refuses to enqueue classified ad media. Deliberately
 *    the last resort: refusing an append can stall the pipeline, so it only
 *    engages once the classifier is past its threshold *and* the ad's extent is
 *    known.
 *
 * Everything the classifier does is evidence-weighted. The DOM contributes
 * evidence; it is never truth.
 */

/** SABR media requests. Anything else is left entirely alone. */
const MEDIA_URL = /googlevideo\.com\/(video|init)playback/;

/** Stop feeding a single response after this much, as a runaway guard. */
const MAX_BYTES_PER_RESPONSE = 64 * 1024 * 1024;

/** How often the skip state machine looks at the player. */
const TICK_MS = 250;

/** Seek only when the engine is this far past its threshold, in nats. */
const SKIP_MARGIN_NATS = 0.5;

const SECOND_US = 1_000_000;

export interface TransportStateReport {
  verdict: "ad" | "content" | "unknown";
  logLr: number;
  lowerThreshold: number;
  upperThreshold: number;
  epoch: number;
  adIntervals: Array<[number, number]>;
  totalAdUs: number;
  evidence: Array<{
    signal: string;
    pAd: number;
    pContent: number;
    logLr: number;
    cumulative: number;
  }>;
  bytesIn: number;
  parts: number;
  bulkBytesSkipped: number;
  peakBuffer: number;
}

let engine: TransportEngine | null = null;
let loading: Promise<TransportEngine> | null = null;
let installed = false;

/**
 * Load the transport engine.
 *
 * Deliberately lazy: the module is only fetched once a SABR media request is
 * actually seen, so a YouTube page that never starts playback never pays for it
 * and no other site ever touches it.
 */
function loadEngine(wasmUrl: string): Promise<TransportEngine> {
  loading ??= (async () => {
    await initTransportWasm({ module_or_path: wasmUrl });
    engine = new TransportEngine();
    const videoId = currentVideoId();
    if (videoId) engine.setRequestedVideo(videoId);
    return engine;
  })();
  return loading;
}

function currentVideoId(): string | null {
  try {
    return new URL(location.href).searchParams.get("v");
  } catch {
    return null;
  }
}

/** The player element, if the page has one. */
function player(): (Element & { classList: DOMTokenList }) | null {
  return document.querySelector("#movie_player");
}

function videoElement(): HTMLVideoElement | null {
  return document.querySelector("video.html5-main-video");
}

/**
 * Feed a response body to the engine without consuming it.
 *
 * `tee` gives two independent streams from one body: the page reads its branch
 * exactly as it would have, and 404AD reads the other. The page's playback path
 * is never in 404AD's critical path, so a slow or failed analysis cannot stall
 * the video.
 */
function observeBody(
  body: ReadableStream<Uint8Array>,
  active: TransportEngine,
): ReadableStream<Uint8Array> {
  const [toPage, toEngine] = body.tee();

  void (async () => {
    const reader = toEngine.getReader();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.byteLength;
        if (total > MAX_BYTES_PER_RESPONSE) break;
        try {
          active.push(value);
        } catch (error) {
          // A framing error means this response is not what we thought it was.
          // Stop analysing it; never let that touch playback.
          console.warn("404AD: transport parse stopped", error);
          break;
        }
      }
    } catch {
      // The page cancelled the request, which is ordinary.
    } finally {
      reader.releaseLock();
    }
  })();

  return toPage;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installFetchHook(wasmUrl: string): void {
  const host = globalThis as unknown as Record<string, unknown>;
  const original = host.fetch as typeof fetch | undefined;
  if (typeof original !== "function") return;

  host.fetch = async function transportFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await original.call(globalThis, input, init);
    if (!MEDIA_URL.test(urlOf(input)) || !response.body || !response.ok) {
      return response;
    }

    try {
      const active = engine ?? (await loadEngine(wasmUrl));
      const toPage = observeBody(response.body, active);
      return new Response(toPage, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      // Analysis is optional. Playback is not.
      console.warn("404AD: transport engine unavailable", error);
      return response;
    }
  };
}

/**
 * The MediaSource gate.
 *
 * Only refuses an append when the classifier has crossed its threshold with
 * margin *and* the ad's extent is known, because a refused append can stall the
 * pipeline. Anything less certain is appended: showing an ad is recoverable,
 * stalling the player is not.
 */
function installBufferGate(): void {
  const proto = globalThis.SourceBuffer?.prototype;
  if (!proto) return;

  const originalAppend = proto.appendBuffer;
  proto.appendBuffer = function gatedAppend(this: SourceBuffer, data: BufferSource) {
    const active = engine;
    if (active) {
      try {
        // New data lands at the end of what is already buffered, so that is the
        // transport position this append is about.
        const ranges = this.buffered;
        const end = ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
        const at = end * SECOND_US;

        const state = active.state() as TransportStateReport;
        const confident = state.logLr >= state.upperThreshold + SKIP_MARGIN_NATS;
        const known = active.resumeTarget(at) !== undefined;

        if (confident && known && !active.shouldAppend(at)) {
          // Dropped on purpose: this is classified advertising media.
          return;
        }
      } catch {
        // Never let the gate be the reason a segment fails to append.
      }
    }
    return originalAppend.call(this, data);
  };
}

/**
 * The skip state machine.
 *
 * Reports the player's own state as evidence, and acts on the engine's verdict
 * by seeking to the end of the classified ad interval. Seeking is preferred
 * over waiting: it returns control to the viewer immediately.
 */
function installSkipLoop(): () => void {
  let lastReportedAdState: boolean | null = null;
  let lastSkipTarget = -1;

  const tick = (): void => {
    const active = engine;
    const video = videoElement();
    const element = player();
    if (!active || !video || !element) return;

    const showingAd = element.classList.contains("ad-showing");
    if (showingAd !== lastReportedAdState) {
      lastReportedAdState = showingAd;
      try {
        active.observe(showingAd ? "player-ad" : "player-content");
      } catch {
        // An unknown signal name is a programming error, not a page error.
      }
    }

    if (!Number.isFinite(video.currentTime)) return;
    const at = video.currentTime * SECOND_US;

    const target = active.resumeTarget(at);
    if (target === undefined) return;

    const seconds = target / SECOND_US;
    // Re-seeking to the same place in a loop would fight the player.
    if (Math.abs(seconds - lastSkipTarget) < 0.05) return;
    if (!Number.isFinite(video.duration) || seconds >= video.duration) return;

    lastSkipTarget = seconds;
    video.currentTime = seconds;
    if (video.paused) void video.play().catch(() => undefined);
  };

  const timer = setInterval(tick, TICK_MS);
  return () => clearInterval(timer);
}

/**
 * Install the transport engine.
 *
 * `wasmUrl` is an extension URL supplied by the content script. Nothing is
 * fetched from the network: the module is part of the package.
 */
export function installTransport(wasmUrl: string): void {
  if (installed || !wasmUrl) return;
  installed = true;

  installFetchHook(wasmUrl);
  installBufferGate();
  const stopLoop = installSkipLoop();

  // A single-page navigation means a different video; nothing learned about the
  // previous stream is valid for the next one.
  globalThis.addEventListener("yt-navigate-finish", () => {
    const videoId = currentVideoId();
    if (engine && videoId) engine.setRequestedVideo(videoId);
  });
  globalThis.addEventListener("pagehide", () => stopLoop(), { once: true });

  // Exposed for the diagnostics panel, which reads it through the page bridge.
  Object.defineProperty(globalThis, "__404AD_TRANSPORT__", {
    value: () => (engine ? (engine.state() as TransportStateReport) : null),
    configurable: true,
    enumerable: false,
  });
}

/** Feed the classifier a signal observed elsewhere in the page. */
export function reportTransportSignal(signal: string): void {
  try {
    engine?.observe(signal);
  } catch {
    // Signals are advisory; a rejected one must never break the caller.
  }
}

/** Test seam. */
export function resetTransportForTests(): void {
  engine = null;
  loading = null;
  installed = false;
}
