/**
 * The scriptlet library.
 *
 * Every function here runs in the **page's own realm**, before the page's
 * scripts, with no access to extension APIs. They are surgical: each one
 * neutralises a specific anti-adblock or tracking technique by making the
 * property, timer or request the page expects behave harmlessly, rather than by
 * removing it and letting the page throw.
 */

export type Scriptlet = (args: string[]) => void;

/** Resolve a dotted path to its owning object and final key. */
function resolvePath(
  root: object,
  path: string,
): { owner: Record<string, unknown>; key: string } | null {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) return null;
  let owner = root as Record<string, unknown>;
  for (const part of parts) {
    const next = owner[part];
    if (next === null || (typeof next !== "object" && typeof next !== "function")) return null;
    owner = next as Record<string, unknown>;
  }
  return { owner, key };
}

function coerce(raw: string | undefined): unknown {
  switch (raw) {
    case undefined:
    case "undefined":
      return undefined;
    case "false":
      return false;
    case "true":
      return true;
    case "null":
      return null;
    case "noopFunc":
      return () => undefined;
    case "trueFunc":
      return () => true;
    case "falseFunc":
      return () => false;
    case "emptyArray":
      return [];
    case "emptyObj":
      return {};
    case "":
      return "";
    default: {
      const n = Number(raw);
      return Number.isNaN(n) || raw.trim() === "" ? raw : n;
    }
  }
}

/** Build a matcher from a literal or a `/regex/` argument. */
function matcher(pattern: string | undefined): (value: string) => boolean {
  if (!pattern || pattern === "*") return () => true;
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (value) => re.test(value);
    } catch {
      return () => false;
    }
  }
  return (value) => value.includes(pattern);
}

/**
 * `set-constant(path, value)` — pin a property to a fixed value.
 *
 * Defined as a non-configurable getter so the page cannot overwrite it, but the
 * setter is a silent no-op rather than a throw: pages routinely assign to these
 * flags and a TypeError would break them more visibly than the ad would.
 */
const setConstant: Scriptlet = ([path, rawValue]) => {
  if (!path) return;
  const value = coerce(rawValue);
  const parts = path.split(".");

  const define = (owner: Record<string, unknown>, key: string): void => {
    try {
      Object.defineProperty(owner, key, {
        get: () => value,
        set: () => undefined,
        configurable: false,
      });
    } catch {
      // Already non-configurable. Nothing safe to do.
    }
  };

  // The path may not exist yet, so walk it lazily: each missing level installs
  // a setter that continues the walk once the page creates it.
  const walk = (owner: Record<string, unknown>, index: number): void => {
    const key = parts[index];
    if (key === undefined) return;
    if (index === parts.length - 1) {
      define(owner, key);
      return;
    }
    const existing = owner[key];
    if (existing && (typeof existing === "object" || typeof existing === "function")) {
      walk(existing as Record<string, unknown>, index + 1);
      return;
    }
    let stored: unknown;
    try {
      Object.defineProperty(owner, key, {
        get: () => stored,
        set: (v: unknown) => {
          stored = v;
          if (v && (typeof v === "object" || typeof v === "function")) {
            walk(v as Record<string, unknown>, index + 1);
          }
        },
        configurable: true,
      });
    } catch {
      // Sealed object; give up on this branch.
    }
  };
  walk(globalThis as unknown as Record<string, unknown>, 0);
};

/** `abort-on-property-read(path)` — throw when a detector reads a property. */
const abortOnPropertyRead: Scriptlet = ([path]) => {
  if (!path) return;
  const target = resolvePath(globalThis, path);
  if (!target) return;
  const token = `404AD:${Math.random().toString(36).slice(2)}`;
  try {
    Object.defineProperty(target.owner, target.key, {
      get() {
        throw new ReferenceError(token);
      },
      set() {
        /* swallow */
      },
      configurable: false,
    });
  } catch {
    /* already locked */
  }
};

/** `abort-on-property-write(path)` — throw when a detector installs a hook. */
const abortOnPropertyWrite: Scriptlet = ([path]) => {
  if (!path) return;
  const target = resolvePath(globalThis, path);
  if (!target) return;
  const token = `404AD:${Math.random().toString(36).slice(2)}`;
  let current = target.owner[target.key];
  try {
    Object.defineProperty(target.owner, target.key, {
      get: () => current,
      set() {
        throw new ReferenceError(token);
      },
      configurable: false,
    });
  } catch {
    current = undefined;
  }
};

/**
 * A peer connection that satisfies feature detection and does nothing.
 *
 * Returning a shaped object rather than throwing keeps a page that probes for
 * WebRTC support from taking its error path.
 */
function NeuteredRTCPeerConnection() {
  return {
    close: () => undefined,
    createDataChannel: () => ({ close: () => undefined }),
    createOffer: () => Promise.reject(new Error("disabled")),
    setRemoteDescription: () => Promise.reject(new Error("disabled")),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

/** `nowebrtc()` — stop RTCPeerConnection being used for IP discovery. */
const noWebrtc: Scriptlet = () => {
  const host = globalThis as unknown as Record<string, unknown>;
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"] as const) {
    if (typeof host[name] !== "function") continue;
    host[name] = NeuteredRTCPeerConnection;
  }
};

/** The URL a `fetch` argument refers to, in any of its three input shapes. */
export function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Install a `fetch` replacement.
 *
 * Assigned through an index signature rather than `globalThis.fetch = ...`:
 * `typeof fetch` carries runtime-specific extras in some toolchains, and a
 * replacement is not obliged to reproduce them to behave correctly in a page.
 */
export function patchFetchWith(
  replacement: (
    original: typeof fetch,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): void {
  const host = globalThis as unknown as Record<string, unknown>;
  const original = host.fetch as typeof fetch | undefined;
  if (typeof original !== "function") return;
  host.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    return replacement(original, input, init);
  };
}

/** `no-fetch-if(pattern)` — resolve matching fetches with an empty response. */
const noFetchIf: Scriptlet = ([pattern]) => {
  const matches = matcher(pattern);
  patchFetchWith((original, input, init) => {
    if (matches(fetchUrl(input))) {
      // An empty 200 is far safer than a rejection: callers almost never
      // handle a rejected fetch, and an unhandled rejection breaks the page.
      return Promise.resolve(new Response("", { status: 200, statusText: "OK" }));
    }
    return original.call(globalThis, input, init);
  });
};

/** `no-xhr-if(pattern)` — make matching XHRs complete with an empty body. */
const noXhrIf: Scriptlet = ([pattern]) => {
  const matches = matcher(pattern);
  const OriginalXhr = globalThis.XMLHttpRequest;
  if (typeof OriginalXhr !== "function") return;

  const open = OriginalXhr.prototype.open;
  const send = OriginalXhr.prototype.send;
  const flagged = new WeakSet<XMLHttpRequest>();

  OriginalXhr.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    if (matches(String(url))) flagged.add(this);
    return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof open;

  OriginalXhr.prototype.send = function patchedSend(this: XMLHttpRequest, body?: unknown) {
    if (!flagged.has(this)) return (send as (...a: unknown[]) => void).call(this, body);
    Object.defineProperties(this, {
      readyState: { value: 4, configurable: true },
      status: { value: 200, configurable: true },
      responseText: { value: "", configurable: true },
      response: { value: "", configurable: true },
    });
    setTimeout(() => {
      this.dispatchEvent(new Event("readystatechange"));
      this.dispatchEvent(new Event("load"));
      this.dispatchEvent(new Event("loadend"));
    }, 0);
  } as typeof send;
};

/** `json-prune(paths)` — delete dotted paths from every JSON.parse result. */
const jsonPrune: Scriptlet = (args) => {
  const paths = args.filter(Boolean);
  if (paths.length === 0) return;
  const original = JSON.parse;

  const prune = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    for (const path of paths) {
      const target = resolvePath(value as object, path);
      if (target && target.key in target.owner) delete target.owner[target.key];
    }
    return value;
  };

  JSON.parse = function patchedParse(text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    return prune(original.call(JSON, text, reviver));
  };
};

/**
 * Replace a global timer function with one that drops matching callbacks.
 *
 * Returning `0` rather than never calling the original keeps the page's own
 * `clearTimeout(id)` bookkeeping valid: `0` is a legal id to clear.
 *
 * Typed through `unknown` because the DOM and Node declarations of these
 * globals disagree on the return type, and the page realm always uses the DOM
 * one regardless of what the toolchain has loaded.
 */
function patchTimer(name: "setTimeout" | "setInterval", pattern: string | undefined): void {
  const matches = matcher(pattern);
  const host = globalThis as unknown as Record<string, unknown>;
  const original = host[name];
  if (typeof original !== "function") return;
  const call = original as (...args: unknown[]) => unknown;

  host[name] = function patched(handler: unknown, ...rest: unknown[]): unknown {
    const body = typeof handler === "function" ? handler.toString() : String(handler);
    if (matches(body)) return 0;
    return call.call(globalThis, handler, ...rest);
  };
}

/** `prevent-setTimeout(pattern)` — drop timers whose body matches. */
const preventSetTimeout: Scriptlet = ([pattern]) => patchTimer("setTimeout", pattern);

/** `prevent-setInterval(pattern)` — drop intervals whose body matches. */
const preventSetInterval: Scriptlet = ([pattern]) => patchTimer("setInterval", pattern);

/** `remove-attr(attr, selector)` — strip an attribute, now and on mutation. */
const removeAttr: Scriptlet = ([attr, selector]) => {
  if (!attr) return;
  const query = selector || `[${attr}]`;
  const strip = (): void => {
    for (const el of document.querySelectorAll(query)) el.removeAttribute(attr);
  };
  strip();
  new MutationObserver(strip).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [attr],
  });
};

/** `remove-class(class, selector)` — strip a class, now and on mutation. */
const removeClass: Scriptlet = ([className, selector]) => {
  if (!className) return;
  const query = selector || `.${className}`;
  const strip = (): void => {
    for (const el of document.querySelectorAll(query)) el.classList.remove(className);
  };
  strip();
  new MutationObserver(strip).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
};

export const SCRIPTLETS: Record<string, Scriptlet> = {
  "set-constant": setConstant,
  "abort-on-property-read": abortOnPropertyRead,
  "abort-on-property-write": abortOnPropertyWrite,
  nowebrtc: noWebrtc,
  "no-fetch-if": noFetchIf,
  "no-xhr-if": noXhrIf,
  "json-prune": jsonPrune,
  "prevent-setTimeout": preventSetTimeout,
  "prevent-set-timeout": preventSetTimeout,
  "prevent-setInterval": preventSetInterval,
  "prevent-set-interval": preventSetInterval,
  "remove-attr": removeAttr,
  "remove-class": removeClass,
};
