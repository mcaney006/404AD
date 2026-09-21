import { beforeAll, describe, expect, test } from "bun:test";
import initTransportWasm, { TransportEngine } from "../wasm/fad_yt_wasm.js";
import type { TransportStateReport } from "./youtube-transport";

/**
 * The shipped WASM engine, driven through the same boundary the page uses.
 *
 * The Rust tests cover the engine's logic. This covers the artifact: that the
 * module in `public/wasm` exposes the stream lifecycle, and that a real
 * UMP-framed body reaches a verdict through it.
 */

const PART = {
  mediaHeader: 20,
  media: 21,
  sabrRedirect: 43,
} as const;

const FIELD = {
  videoId: 2,
  itag: 3,
  sequenceNumber: 9,
  startMs: 11,
  durationMs: 12,
} as const;

/** The UMP prefix-length varint, which is not protobuf's. */
function umpVarint(value: number, out: number[]): void {
  if (value < 0x80) out.push(value);
  else if (value < 0x4000) out.push(0x80 | (value & 0x3f), value >> 6);
  else if (value < 0x200000) out.push(0xc0 | (value & 0x1f), (value >> 5) & 0xff, value >> 13);
  else {
    out.push(0xff);
    for (let shift = 0; shift < 32; shift += 8) out.push((value >>> shift) & 0xff);
  }
}

function protoVarint(value: number, out: number[]): void {
  for (;;) {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value === 0) {
      out.push(byte);
      return;
    }
    out.push(byte | 0x80);
  }
}

function varintField(field: number, value: number, out: number[]): void {
  protoVarint(field << 3, out);
  protoVarint(value, out);
}

function bytesField(field: number, value: string, out: number[]): void {
  const encoded = [...new TextEncoder().encode(value)];
  protoVarint((field << 3) | 2, out);
  protoVarint(encoded.length, out);
  out.push(...encoded);
}

function part(kind: number, payload: number[], out: number[]): void {
  umpVarint(kind, out);
  umpVarint(payload.length, out);
  out.push(...payload);
}

function mediaHeader(videoId: string, itag: number, seq: number, startMs: number): number[] {
  const body: number[] = [];
  bytesField(FIELD.videoId, videoId, body);
  varintField(FIELD.itag, itag, body);
  varintField(FIELD.sequenceNumber, seq, body);
  varintField(FIELD.startMs, startMs, body);
  varintField(FIELD.durationMs, 5_000, body);
  return body;
}

/** A SABR response carrying `count` five-second segments of one video. */
function sabrResponse(videoId: string, count: number, firstSeq = 0): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = firstSeq + i;
    part(PART.mediaHeader, mediaHeader(videoId, 137, seq, seq * 5_000), out);
    part(
      PART.media,
      Array.from({ length: 256 }, () => 0),
      out,
    );
  }
  return new Uint8Array(out);
}

let engine: TransportEngine;

beforeAll(async () => {
  const wasm = await Bun.file(
    new URL("../../public/wasm/fad_yt_wasm_bg.wasm", import.meta.url).pathname,
  ).arrayBuffer();
  await initTransportWasm({ module_or_path: wasm });
});

function fresh(videoId = "dQw4w9WgXcQ"): TransportEngine {
  engine = new TransportEngine();
  engine.setRequestedVideo(videoId);
  return engine;
}

function report(active: TransportEngine): TransportStateReport {
  return active.state() as TransportStateReport;
}

describe("the shipped transport engine", () => {
  test("classifies a continuous SABR response as content", () => {
    const active = fresh();
    const stream = active.openStream();
    for (const chunk of chunked(sabrResponse("dQw4w9WgXcQ", 4), 64)) {
      active.pushStream(stream, chunk);
    }

    expect(active.closeStream(stream)).toBe(true);
    expect(active.verdict()).toBe("content");
    const state = report(active);
    expect(state.nonUmpResponses).toBe(0);
    expect(state.adIntervals).toEqual([]);
    expect(state.bulkBytesSkipped).toBe(4 * 256);
  });

  test("refuses a body that is not UMP and lets playback alone", () => {
    const active = fresh();
    const stream = active.openStream();
    const json = new TextEncoder().encode('{"error":{"code":403,"status":"DENIED"}}');
    expect(() => active.pushStream(stream, json)).not.toThrow();

    const state = report(active);
    expect(state.nonUmpResponses).toBe(1);
    expect(state.verdict).toBe("unknown");
    expect(active.shouldAppend(0)).toBe(true);
  });

  test("keeps two in-flight responses from interleaving into one framing", () => {
    const active = fresh();
    const a = active.openStream();
    const b = active.openStream();
    const first = [...chunked(sabrResponse("dQw4w9WgXcQ", 3), 37)];
    const second = [...chunked(sabrResponse("dQw4w9WgXcQ", 3, 3), 41)];

    for (let i = 0; i < Math.max(first.length, second.length); i += 1) {
      if (first[i]) active.pushStream(a, first[i]!);
      if (second[i]) active.pushStream(b, second[i]!);
    }

    expect(report(active).openStreams).toBe(2);
    expect(active.closeStream(a)).toBe(true);
    expect(active.closeStream(b)).toBe(true);
    expect(report(active).nonUmpResponses).toBe(0);
    expect(active.verdict()).toBe("content");
  });

  test("a cancelled response does not desynchronise the next one", () => {
    const active = fresh();
    const body = sabrResponse("dQw4w9WgXcQ", 2);

    const cancelled = active.openStream();
    // Cut inside the last media payload, which is what an aborted fetch does.
    active.pushStream(cancelled, body.subarray(0, body.length - 100));
    expect(active.closeStream(cancelled)).toBe(false);
    expect(report(active).truncatedResponses).toBe(1);

    const next = active.openStream();
    const outcome = active.pushStream(next, sabrResponse("dQw4w9WgXcQ", 3, 2)) as {
      headers: number;
    };
    expect(outcome.headers).toBe(3);
  });

  test("a viewer scrub is absorbed rather than charged as evidence", () => {
    const active = fresh();
    const stream = active.openStream();
    active.pushStream(stream, sabrResponse("dQw4w9WgXcQ", 3));

    active.notifySeek();
    expect(report(active).evidence).toEqual([]);

    // Media resumes ten minutes in, discontinuous with everything before it.
    active.pushStream(stream, sabrResponse("dQw4w9WgXcQ", 3, 120));
    const state = report(active);
    expect(state.evidence.some((e) => e.signal === "media timeline discontinuity")).toBe(false);
    expect(state.verdict).not.toBe("ad");
  });

  test("a redirect is not a content change", () => {
    const active = fresh();
    const stream = active.openStream();
    active.pushStream(stream, sabrResponse("dQw4w9WgXcQ", 3));
    const before = report(active).epoch;

    const redirect: number[] = [];
    part(
      PART.sabrRedirect,
      [...new TextEncoder().encode("https://rr3.googlevideo.com/")],
      redirect,
    );
    active.pushStream(stream, new Uint8Array(redirect));

    const state = report(active);
    expect(state.epoch).toBe(before);
    expect(state.evidence.some((e) => e.signal === "new transport epoch")).toBe(false);
  });
});

function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}
