(function() {
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/define-unlisted-script.mjs
	function defineUnlistedScript(arg) {
		if (arg == null || typeof arg === "function") return { main: arg };
		return arg;
	}
	//#endregion
	//#region src/scriptlets/library.ts
	/** Resolve a dotted path to its owning object and final key. */
	function resolvePath(root, path) {
		const parts = path.split(".");
		const key = parts.pop();
		if (!key) return null;
		let owner = root;
		for (const part of parts) {
			const next = owner[part];
			if (next === null || typeof next !== "object" && typeof next !== "function") return null;
			owner = next;
		}
		return {
			owner,
			key
		};
	}
	function coerce(raw) {
		switch (raw) {
			case void 0:
			case "undefined": return;
			case "false": return false;
			case "true": return true;
			case "null": return null;
			case "noopFunc": return () => void 0;
			case "trueFunc": return () => true;
			case "falseFunc": return () => false;
			case "emptyArray": return [];
			case "emptyObj": return {};
			case "": return "";
			default: {
				const n = Number(raw);
				return Number.isNaN(n) || raw.trim() === "" ? raw : n;
			}
		}
	}
	/** Build a matcher from a literal or a `/regex/` argument. */
	function matcher(pattern) {
		if (!pattern || pattern === "*") return () => true;
		if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) try {
			const re = new RegExp(pattern.slice(1, -1));
			return (value) => re.test(value);
		} catch {
			return () => false;
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
	var setConstant = ([path, rawValue]) => {
		if (!path) return;
		const value = coerce(rawValue);
		const parts = path.split(".");
		const define = (owner, key) => {
			try {
				Object.defineProperty(owner, key, {
					get: () => value,
					set: () => void 0,
					configurable: false
				});
			} catch {}
		};
		const walk = (owner, index) => {
			const key = parts[index];
			if (key === void 0) return;
			if (index === parts.length - 1) {
				define(owner, key);
				return;
			}
			const existing = owner[key];
			if (existing && (typeof existing === "object" || typeof existing === "function")) {
				walk(existing, index + 1);
				return;
			}
			let stored;
			try {
				Object.defineProperty(owner, key, {
					get: () => stored,
					set: (v) => {
						stored = v;
						if (v && (typeof v === "object" || typeof v === "function")) walk(v, index + 1);
					},
					configurable: true
				});
			} catch {}
		};
		walk(globalThis, 0);
	};
	/** `abort-on-property-read(path)` — throw when a detector reads a property. */
	var abortOnPropertyRead = ([path]) => {
		if (!path) return;
		const target = resolvePath(globalThis, path);
		if (!target) return;
		const token = `404AD:${Math.random().toString(36).slice(2)}`;
		try {
			Object.defineProperty(target.owner, target.key, {
				get() {
					throw new ReferenceError(token);
				},
				set() {},
				configurable: false
			});
		} catch {}
	};
	/** `abort-on-property-write(path)` — throw when a detector installs a hook. */
	var abortOnPropertyWrite = ([path]) => {
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
				configurable: false
			});
		} catch {
			current = void 0;
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
			close: () => void 0,
			createDataChannel: () => ({ close: () => void 0 }),
			createOffer: () => Promise.reject(/* @__PURE__ */ new Error("disabled")),
			setRemoteDescription: () => Promise.reject(/* @__PURE__ */ new Error("disabled")),
			addEventListener: () => void 0,
			removeEventListener: () => void 0
		};
	}
	/** `nowebrtc()` — stop RTCPeerConnection being used for IP discovery. */
	var noWebrtc = () => {
		const host = globalThis;
		for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
			if (typeof host[name] !== "function") continue;
			host[name] = NeuteredRTCPeerConnection;
		}
	};
	/** The URL a `fetch` argument refers to, in any of its three input shapes. */
	function fetchUrl(input) {
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
	function patchFetchWith(replacement) {
		const host = globalThis;
		const original = host.fetch;
		if (typeof original !== "function") return;
		host.fetch = function patchedFetch(input, init) {
			return replacement(original, input, init);
		};
	}
	/** `no-fetch-if(pattern)` — resolve matching fetches with an empty response. */
	var noFetchIf = ([pattern]) => {
		const matches = matcher(pattern);
		patchFetchWith((original, input, init) => {
			if (matches(fetchUrl(input))) return Promise.resolve(new Response("", {
				status: 200,
				statusText: "OK"
			}));
			return original.call(globalThis, input, init);
		});
	};
	/** `no-xhr-if(pattern)` — make matching XHRs complete with an empty body. */
	var noXhrIf = ([pattern]) => {
		const matches = matcher(pattern);
		const OriginalXhr = globalThis.XMLHttpRequest;
		if (typeof OriginalXhr !== "function") return;
		const open = OriginalXhr.prototype.open;
		const send = OriginalXhr.prototype.send;
		const flagged = /* @__PURE__ */ new WeakSet();
		OriginalXhr.prototype.open = function patchedOpen(method, url, ...rest) {
			if (matches(String(url))) flagged.add(this);
			return open.call(this, method, url, ...rest);
		};
		OriginalXhr.prototype.send = function patchedSend(body) {
			if (!flagged.has(this)) return send.call(this, body);
			Object.defineProperties(this, {
				readyState: {
					value: 4,
					configurable: true
				},
				status: {
					value: 200,
					configurable: true
				},
				responseText: {
					value: "",
					configurable: true
				},
				response: {
					value: "",
					configurable: true
				}
			});
			setTimeout(() => {
				this.dispatchEvent(new Event("readystatechange"));
				this.dispatchEvent(new Event("load"));
				this.dispatchEvent(new Event("loadend"));
			}, 0);
		};
	};
	/** `json-prune(paths)` — delete dotted paths from every JSON.parse result. */
	var jsonPrune = (args) => {
		const paths = args.filter(Boolean);
		if (paths.length === 0) return;
		const original = JSON.parse;
		const prune = (value) => {
			if (value === null || typeof value !== "object") return value;
			for (const path of paths) {
				const target = resolvePath(value, path);
				if (target && target.key in target.owner) delete target.owner[target.key];
			}
			return value;
		};
		JSON.parse = function patchedParse(text, reviver) {
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
	function patchTimer(name, pattern) {
		const matches = matcher(pattern);
		const host = globalThis;
		const original = host[name];
		if (typeof original !== "function") return;
		const call = original;
		host[name] = function patched(handler, ...rest) {
			const body = typeof handler === "function" ? handler.toString() : String(handler);
			if (matches(body)) return 0;
			return call.call(globalThis, handler, ...rest);
		};
	}
	/** `prevent-setTimeout(pattern)` — drop timers whose body matches. */
	var preventSetTimeout = ([pattern]) => patchTimer("setTimeout", pattern);
	/** `prevent-setInterval(pattern)` — drop intervals whose body matches. */
	var preventSetInterval = ([pattern]) => patchTimer("setInterval", pattern);
	/** `remove-attr(attr, selector)` — strip an attribute, now and on mutation. */
	var removeAttr = ([attr, selector]) => {
		if (!attr) return;
		const query = selector || `[${attr}]`;
		const strip = () => {
			for (const el of document.querySelectorAll(query)) el.removeAttribute(attr);
		};
		strip();
		new MutationObserver(strip).observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [attr]
		});
	};
	/** `remove-class(class, selector)` — strip a class, now and on mutation. */
	var removeClass = ([className, selector]) => {
		if (!className) return;
		const query = selector || `.${className}`;
		const strip = () => {
			for (const el of document.querySelectorAll(query)) el.classList.remove(className);
		};
		strip();
		new MutationObserver(strip).observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"]
		});
	};
	var SCRIPTLETS = {
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
		"remove-class": removeClass
	};
	//#endregion
	//#region src/adapters/youtube.ts
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
	var AD_KEYS = [
		"adPlacements",
		"playerAds",
		"adSlots",
		"adBreakHeartbeatParams"
	];
	/**
	* Renderer types YouTube uses to represent an ad inside `ytInitialData`.
	*
	* Hiding these with CSS works, but leaves the item in the data model and leaves
	* a gap where the grid still reserves space for it. Deleting the entry instead
	* makes the feed behave as though the ad was never served.
	*/
	var AD_RENDERERS = /* @__PURE__ */ new Set([
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
		"videoMastheadAdV3Renderer"
	]);
	/**
	* `ytInitialData` is on the order of a megabyte. Walking it is worth it once
	* per navigation and never worth it unboundedly, so the walk carries a node
	* budget and stops rather than becoming the thing that makes the page slow.
	*/
	var PRUNE_NODE_BUDGET = 2e5;
	/** Remove every ad-bearing key from a player response, in place. */
	function stripAdPayload(value) {
		if (value === null || typeof value !== "object") return value;
		const record = value;
		for (const key of AD_KEYS) if (key in record) delete record[key];
		for (const nested of ["playerResponse", "response"]) if (record[nested] && typeof record[nested] === "object") stripAdPayload(record[nested]);
		return value;
	}
	/**
	* Recursively drop array entries that are ad renderers.
	*
	* Only array elements are removed. An ad renderer always appears as one item in
	* a list of items, so deleting the element is the surgical edit; deleting the
	* key it hangs off would take the surrounding section with it.
	*/
	function pruneAdRenderers(root) {
		let budget = PRUNE_NODE_BUDGET;
		const isAdEntry = (value) => value !== null && typeof value === "object" && Object.keys(value).some((key) => AD_RENDERERS.has(key));
		const walk = (value) => {
			if (budget <= 0 || value === null || typeof value !== "object") return;
			budget -= 1;
			if (Array.isArray(value)) {
				for (let i = value.length - 1; i >= 0; i -= 1) if (isAdEntry(value[i])) value.splice(i, 1);
				else walk(value[i]);
				return;
			}
			const record = value;
			for (const key of Object.keys(record)) {
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
	function looksLikeInitialData(value) {
		if (value === null || typeof value !== "object") return false;
		const record = value;
		return "contents" in record || "onResponseReceivedActions" in record || "onResponseReceivedEndpoints" in record;
	}
	function looksLikePlayerResponse(value) {
		if (value === null || typeof value !== "object") return false;
		const record = value;
		return "streamingData" in record || "videoDetails" in record || "playerResponse" in record || AD_KEYS.some((key) => key in record);
	}
	/** Part 1a: strip ads from anything the page parses as JSON. */
	function patchJsonParse() {
		const original = JSON.parse;
		JSON.parse = function patchedParse(text, reviver) {
			const parsed = original.call(JSON, text, reviver);
			if (looksLikePlayerResponse(parsed)) return stripAdPayload(parsed);
			if (looksLikeInitialData(parsed)) return pruneAdRenderers(parsed);
			return parsed;
		};
	}
	/** Part 1b: strip ads from player responses fetched by the SPA. */
	function patchFetch() {
		patchFetchWith(async (original, input, init) => {
			const response = await original.call(globalThis, input, init);
			const url = fetchUrl(input);
			if (![
				"/youtubei/v1/player",
				"/youtubei/v1/next",
				"/youtubei/v1/browse",
				"/youtubei/v1/search",
				"/youtubei/v1/reel/reel_watch_sequence"
			].some((path) => url.includes(path))) return response;
			try {
				const payload = pruneAdRenderers(stripAdPayload(await response.clone().json()));
				return new Response(JSON.stringify(payload), {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			} catch {
				return response;
			}
		});
	}
	/** Part 1c: the first player response is inlined as a global, not fetched. */
	function patchInitialResponse() {
		const host = globalThis;
		for (const key of ["ytInitialPlayerResponse", "ytInitialData"]) {
			let stored = host[key];
			if (stored !== void 0) stored = pruneAdRenderers(stripAdPayload(stored));
			try {
				Object.defineProperty(globalThis, key, {
					get: () => stored,
					set: (value) => {
						stored = pruneAdRenderers(stripAdPayload(value));
					},
					configurable: true
				});
			} catch {}
		}
	}
	/**
	* The enforcement interstitial pauses the video and blocks the UI. Removing it
	* without resuming playback leaves a stopped player, which reads as breakage.
	*/
	function dismissEnforcementModal(video) {
		const modal = document.querySelector("ytd-enforcement-message-view-model, tp-yt-paper-dialog:has(ytd-enforcement-message-view-model)");
		if (!modal) return;
		modal.remove();
		document.querySelector("tp-yt-iron-overlay-backdrop")?.remove();
		document.body.style.removeProperty("overflow");
		if (video?.paused) video.play().catch(() => void 0);
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
	var restoreMuted = null;
	var restoreRate = null;
	function installPlayerWatcher() {
		const skipSelectors = [
			".ytp-ad-skip-button",
			".ytp-ad-skip-button-modern",
			".ytp-skip-ad-button",
			".ytp-ad-survey-answer-button"
		];
		const dismissSelectors = [
			".ytp-ad-overlay-close-button",
			".ytp-ad-overlay-close-container",
			".ytp-suggested-action-badge-dismiss-button-icon"
		];
		const tick = () => {
			const player = document.querySelector("#movie_player");
			const video = document.querySelector("video.html5-main-video");
			for (const selector of dismissSelectors) document.querySelector(selector)?.click();
			dismissEnforcementModal(video);
			if (!player || !video) return;
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
			if (restoreMuted === null) restoreMuted = video.muted;
			if (restoreRate === null) restoreRate = video.playbackRate;
			for (const selector of skipSelectors) {
				const button = document.querySelector(selector);
				if (button && button.offsetParent !== null) {
					button.click();
					return;
				}
			}
			if (Number.isFinite(video.duration) && video.duration > 0) {
				video.muted = true;
				if (video.currentTime < video.duration - .15) video.currentTime = video.duration - .05;
				if (video.paused) video.play().catch(() => void 0);
			}
		};
		tick();
		const observer = new MutationObserver(tick);
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"]
		});
		const timer = setInterval(tick, 400);
		return () => {
			observer.disconnect();
			clearInterval(timer);
		};
	}
	/** Install the adapter. Safe to call more than once. */
	function youtubeAdapter() {
		const flag = "__404AD_YT__";
		const host = globalThis;
		if (host[flag]) return;
		host[flag] = true;
		patchInitialResponse();
		patchJsonParse();
		patchFetch();
		let teardown = installPlayerWatcher();
		const rearm = () => {
			teardown();
			teardown = installPlayerWatcher();
		};
		globalThis.addEventListener("yt-navigate-finish", rearm);
		globalThis.addEventListener("pagehide", () => teardown(), { once: true });
	}
	//#endregion
	//#region entrypoints/scriptlets-runtime.ts
	var REGISTRY = {
		...SCRIPTLETS,
		"404ad-yt-player": youtubeAdapter
	};
	function readConfig() {
		const raw = document.currentScript?.getAttribute("data-404ad-scriptlets");
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	var scriptlets_runtime_default = defineUnlistedScript(() => {
		const entries = readConfig();
		if (entries.length === 0) return;
		const host = globalThis;
		const applied = host.__404AD_APPLIED__ ?? /* @__PURE__ */ new Set();
		host.__404AD_APPLIED__ = applied;
		for (const entry of entries) {
			if (entry.shadow) continue;
			const key = `${entry.name}(${entry.args.join(",")})`;
			if (applied.has(key)) continue;
			const scriptlet = REGISTRY[entry.name];
			if (!scriptlet) {
				console.warn(`404AD: unknown scriptlet "${entry.name}"`);
				continue;
			}
			applied.add(key);
			try {
				scriptlet(entry.args);
			} catch (error) {
				console.warn(`404AD: scriptlet "${entry.name}" failed`, error);
			}
		}
	});
	//#endregion
	//#region \0virtual:wxt-unlisted-script-entrypoint?/Users/michael.jr/Developer/404AD/packages/extension/entrypoints/scriptlets-runtime.ts
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => ([...args], void 0),
		log: (...args) => ([...args], void 0),
		warn: (...args) => ([...args], void 0),
		error: (...args) => ([...args], void 0)
	};
	//#endregion
	return (() => {
		let result;
		try {
			result = scriptlets_runtime_default.main();
			if (result instanceof Promise) result = result.catch((err) => {
				logger.error(`The unlisted script "scriptlets-runtime" crashed on startup!`, err);
				throw err;
			});
		} catch (err) {
			logger.error(`The unlisted script "scriptlets-runtime" crashed on startup!`, err);
			throw err;
		}
		return result;
	})();
})();
