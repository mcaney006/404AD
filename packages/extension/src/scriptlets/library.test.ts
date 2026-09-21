import { afterEach, describe, expect, test } from "bun:test";
import { SCRIPTLETS } from "./library";

const host = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();

/** Proves the scriptlet replaced the constructor: this must never run. */
function realConstructorMustNotRun(): never {
  throw new Error("the real constructor should never run");
}

function stash(...keys: string[]): void {
  for (const key of keys) saved.set(key, host[key]);
}

afterEach(() => {
  for (const [key, value] of saved) host[key] = value;
  saved.clear();
  document.body.innerHTML = "";
});

describe("set-constant", () => {
  test("pins a value and silently swallows writes", () => {
    stash("__t1");
    host.__t1 = { flag: true };
    SCRIPTLETS["set-constant"]?.(["__t1.flag", "false"]);

    expect((host.__t1 as { flag: boolean }).flag).toBe(false);
    // A throwing setter would break more pages than the ad it suppresses.
    expect(() => {
      (host.__t1 as { flag: boolean }).flag = true;
    }).not.toThrow();
    expect((host.__t1 as { flag: boolean }).flag).toBe(false);
  });

  test("coerces the documented keywords", () => {
    stash("__t2");
    host.__t2 = {};
    SCRIPTLETS["set-constant"]?.(["__t2.n", "noopFunc"]);
    expect(typeof (host.__t2 as { n: unknown }).n).toBe("function");

    SCRIPTLETS["set-constant"]?.(["__t2.u", "undefined"]);
    expect((host.__t2 as { u: unknown }).u).toBeUndefined();

    SCRIPTLETS["set-constant"]?.(["__t2.num", "42"]);
    expect((host.__t2 as { num: unknown }).num).toBe(42);
  });

  test("installs on a path the page has not created yet", () => {
    stash("__t3");
    delete host.__t3;
    SCRIPTLETS["set-constant"]?.(["__t3.deep.flag", "false"]);

    // The page creates the intermediate object afterwards.
    host.__t3 = { deep: {} };
    expect((host.__t3 as { deep: { flag: unknown } }).deep.flag).toBe(false);
  });
});

describe("abort-on-property-read", () => {
  test("throws when a detector reads the property", () => {
    stash("__t4");
    host.__t4 = { detector: 1 };
    SCRIPTLETS["abort-on-property-read"]?.(["__t4.detector"]);
    expect(() => (host.__t4 as { detector: unknown }).detector).toThrow(ReferenceError);
  });
});

describe("json-prune", () => {
  test("removes dotted paths from every parse result", () => {
    const original = JSON.parse;
    try {
      SCRIPTLETS["json-prune"]?.(["ads", "data.tracking"]);
      const parsed = JSON.parse('{"ads":[1],"data":{"tracking":true,"keep":1},"keep":2}');
      expect(parsed).toEqual({ data: { keep: 1 }, keep: 2 });
    } finally {
      JSON.parse = original;
    }
  });
});

describe("no-fetch-if", () => {
  test("answers matching requests with an empty 200 and passes the rest through", async () => {
    const original = host.fetch;
    let passthrough = 0;
    host.fetch = async () => {
      passthrough += 1;
      return new Response("real");
    };
    try {
      SCRIPTLETS["no-fetch-if"]?.(["/collect"]);
      const blocked = await (host.fetch as typeof fetch)("https://x.test/collect?a=1");
      expect(blocked.status).toBe(200);
      expect(await blocked.text()).toBe("");
      expect(passthrough).toBe(0);

      const allowed = await (host.fetch as typeof fetch)("https://x.test/app.js");
      expect(await allowed.text()).toBe("real");
      expect(passthrough).toBe(1);
    } finally {
      host.fetch = original;
    }
  });

  test("a /regex/ argument is honoured", async () => {
    const original = host.fetch;
    host.fetch = async () => new Response("real");
    try {
      SCRIPTLETS["no-fetch-if"]?.(["/\\/pixel\\/[0-9]+/"]);
      expect(await (await (host.fetch as typeof fetch)("https://x.test/pixel/12")).text()).toBe("");
      expect(await (await (host.fetch as typeof fetch)("https://x.test/pixel/ab")).text()).toBe(
        "real",
      );
    } finally {
      host.fetch = original;
    }
  });
});

describe("prevent-setTimeout", () => {
  test("drops matching callbacks and runs the rest", async () => {
    stash("setTimeout");
    SCRIPTLETS["prevent-setTimeout"]?.(["adRefresh"]);

    let adRan = false;
    let normalRan = false;
    (host.setTimeout as typeof setTimeout)(function adRefresh() {
      adRan = true;
    }, 0);
    (host.setTimeout as typeof setTimeout)(() => {
      normalRan = true;
    }, 0);

    await new Promise((resolve) => (saved.get("setTimeout") as typeof setTimeout)(resolve, 10));
    expect(adRan).toBe(false);
    expect(normalRan).toBe(true);
  });

  test("returns a clearable id so page bookkeeping stays valid", () => {
    stash("setTimeout");
    SCRIPTLETS["prevent-setTimeout"]?.(["*"]);
    const id = (host.setTimeout as typeof setTimeout)(() => undefined, 0);
    expect(() => clearTimeout(id)).not.toThrow();
  });
});

describe("remove-attr and remove-class", () => {
  test("strips an attribute from matching elements", () => {
    document.body.innerHTML = `<a href="#" onclick="track()">x</a>`;
    SCRIPTLETS["remove-attr"]?.(["onclick", "a"]);
    expect(document.querySelector("a")?.hasAttribute("onclick")).toBe(false);
  });

  test("strips a class from matching elements", () => {
    document.body.innerHTML = `<div class="sticky promo"></div>`;
    SCRIPTLETS["remove-class"]?.(["sticky", ".promo"]);
    expect(document.querySelector("div")?.className).toBe("promo");
  });
});

describe("nowebrtc", () => {
  test("replaces RTCPeerConnection with an inert stub", () => {
    stash("RTCPeerConnection");
    host.RTCPeerConnection = realConstructorMustNotRun;
    SCRIPTLETS.nowebrtc?.([]);

    const connection = new (host.RTCPeerConnection as new () => {
      createDataChannel: () => unknown;
    })();
    expect(typeof connection.createDataChannel).toBe("function");
  });
});
