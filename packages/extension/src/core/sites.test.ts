import { describe, expect, test } from "bun:test";
import { hostSuffixes } from "./sites";

describe("hostSuffixes", () => {
  test("walks up to the two-label boundary", () => {
    expect(hostSuffixes("a.b.example.com")).toEqual([
      "a.b.example.com",
      "b.example.com",
      "example.com",
    ]);
  });

  test("a two-label host is its own only suffix", () => {
    expect(hostSuffixes("example.com")).toEqual(["example.com"]);
  });

  test("normalises case and a trailing root dot", () => {
    expect(hostSuffixes("WWW.Example.COM.")).toEqual(["www.example.com", "example.com"]);
  });

  test("a single-label host still resolves", () => {
    expect(hostSuffixes("localhost")).toEqual(["localhost"]);
  });

  test("ordering is most-specific-first so the nearest rule wins", () => {
    const [first] = hostSuffixes("app.example.com");
    expect(first).toBe("app.example.com");
  });
});
