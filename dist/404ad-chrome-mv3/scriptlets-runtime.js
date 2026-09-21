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
	function detectSurface(href) {
		let url;
		try {
			url = new URL(href);
		} catch {
			return "other";
		}
		const { hostname, pathname } = url;
		if (hostname.endsWith("youtube-nocookie.com") || pathname.startsWith("/embed/")) return "embed";
		if (hostname.startsWith("music.")) return "music";
		if (pathname.startsWith("/shorts/")) return "shorts";
		if (pathname === "/watch") return "watch";
		if (pathname === "/results") return "search";
		if (pathname === "/playlist") return "playlist";
		if (pathname === "/" || pathname === "/feed/subscriptions" || pathname.startsWith("/feed/")) return "home";
		if (pathname.startsWith("/@") || pathname.startsWith("/channel/") || pathname.startsWith("/c/")) return "channel";
		return "other";
	}
	/**
	* Player elements on this surface.
	*
	* Several can exist at once: a Shorts page keeps `#shorts-player` alongside a
	* hidden `#movie_player`, and a channel page has an inline trailer player.
	*/
	function findPlayers() {
		const selectors = [
			"#movie_player",
			"#shorts-player",
			"ytd-reel-video-renderer[is-active] #shorts-player",
			"ytmusic-player #movie_player",
			".html5-video-player"
		];
		const found = /* @__PURE__ */ new Set();
		for (const selector of selectors) for (const element of document.querySelectorAll(selector)) found.add(element);
		return [...found];
	}
	/** The `<video>` inside a player, or the page's only one. */
	function videoOf(player) {
		return player?.querySelector("video") ?? document.querySelector("video.html5-main-video");
	}
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
			".ytp-suggested-action-badge-dismiss-button-icon",
			".ytp-ad-visit-advertiser-button-dismiss"
		];
		/**
		* Handle one player.
		*
		* Every surface with a player gets the same treatment, because the ad
		* mechanism is the same even when the wrapper is not. What differs is how the
		* surface is *entered*, which is why re-arming is driven by URL changes
		* rather than by any one player element's lifetime.
		*/
		const handlePlayer = (player) => {
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
			if (restoreMuted === null) restoreMuted = video.muted;
			if (restoreRate === null) restoreRate = video.playbackRate;
			for (const selector of skipSelectors) {
				const button = player.querySelector(selector) ?? document.querySelector(selector);
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
		const tick = () => {
			for (const selector of dismissSelectors) document.querySelector(selector)?.click();
			const players = findPlayers();
			dismissEnforcementModal(videoOf(players[0] ?? null));
			for (const player of players) handlePlayer(player);
			if (detectSurface(location.href) === "shorts") removeShortsAds();
		};
		tick();
		const observer = new MutationObserver(tick);
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"class",
				"is-active",
				"hidden"
			]
		});
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
	function removeShortsAds() {
		const selectors = [
			"ytd-reel-video-renderer:has(ytd-ad-slot-renderer)",
			"ytd-reel-video-renderer:has(ytd-display-ad-renderer)",
			"ytm-reel-item-renderer:has(ytm-promoted-video-renderer)",
			"ytd-reel-video-renderer:has(.ytp-ad-module)"
		];
		let removed = 0;
		for (const selector of selectors) {
			let matches;
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
	function watchNavigation(onNavigate) {
		let previous = location.href;
		const check = () => {
			if (location.href === previous) return;
			previous = location.href;
			onNavigate(detectSurface(location.href));
		};
		const events = [
			"yt-navigate-finish",
			"yt-page-data-updated",
			"popstate",
			"hashchange"
		];
		for (const event of events) globalThis.addEventListener(event, check);
		const timer = setInterval(check, 500);
		return () => {
			for (const event of events) globalThis.removeEventListener(event, check);
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
		const stopNavigation = watchNavigation(() => {
			teardown();
			teardown = installPlayerWatcher();
		});
		globalThis.addEventListener("pagehide", () => {
			teardown();
			stopNavigation();
		}, { once: true });
	}
	//#endregion
	//#region src/wasm/fad_yt_wasm.js
	var TransportEngine = class {
		__destroy_into_raw() {
			const ptr = this.__wbg_ptr;
			this.__wbg_ptr = 0;
			TransportEngineFinalization.unregister(this);
			return ptr;
		}
		free() {
			const ptr = this.__destroy_into_raw();
			wasm.__wbg_transportengine_free(ptr, 0);
		}
		/**
		* Finish a response. Returns true when it ended on a part boundary.
		* @param {number} stream
		* @returns {boolean}
		*/
		closeStream(stream) {
			return wasm.transportengine_closeStream(this.__wbg_ptr, stream) !== 0;
		}
		/**
		* Transport time mapped to the viewer's clock.
		* @param {number} transport_us
		* @returns {number}
		*/
		contentTime(transport_us) {
			return wasm.transportengine_contentTime(this.__wbg_ptr, transport_us);
		}
		constructor() {
			const ret = wasm.transportengine_new();
			this.__wbg_ptr = ret;
			TransportEngineFinalization.register(this, this.__wbg_ptr, this);
			return this;
		}
		/**
		* The viewer seeked. Starts a fresh epoch without charging it as evidence.
		*/
		notifySeek() {
			wasm.transportengine_notifySeek(this.__wbg_ptr);
		}
		/**
		* Record an observation from the page.
		*
		* Returns the verdict after the observation. An unknown signal name is an
		* error rather than a silent no-op: a typo here would quietly remove
		* evidence from the test.
		* @param {string} signal
		* @returns {string}
		*/
		observe(signal) {
			let deferred3_0;
			let deferred3_1;
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passStringToWasm0(signal, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len0 = WASM_VECTOR_LEN;
				wasm.transportengine_observe(retptr, this.__wbg_ptr, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				var r2 = getDataViewMemory0().getInt32(retptr + 8, true);
				var r3 = getDataViewMemory0().getInt32(retptr + 12, true);
				var ptr2 = r0;
				var len2 = r1;
				if (r3) {
					ptr2 = 0;
					len2 = 0;
					throw takeObject(r2);
				}
				deferred3_0 = ptr2;
				deferred3_1 = len2;
				return getStringFromWasm0(ptr2, len2);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
				wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
			}
		}
		/**
		* Begin reading one SABR response, returning its stream id.
		*
		* One per response, always. UMP framing belongs to a response: the player
		* cancels requests mid-part and runs several in flight at once, so a
		* shared parser is consuming two framings out of one buffer.
		* @returns {number}
		*/
		openStream() {
			return wasm.transportengine_openStream(this.__wbg_ptr) >>> 0;
		}
		/**
		* What to do with media at this transport timestamp, in microseconds.
		* @param {number} transport_us
		* @returns {any}
		*/
		policyAt(transport_us) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.transportengine_policyAt(retptr, this.__wbg_ptr, transport_us);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* Drop timeline history behind the playback cursor.
		* @param {number} before_us
		*/
		prune(before_us) {
			wasm.transportengine_prune(this.__wbg_ptr, before_us);
		}
		/**
		* Feed one network chunk. The only per-chunk call across the boundary.
		* @param {number} stream
		* @param {Uint8Array} chunk
		* @returns {any}
		*/
		pushStream(stream, chunk) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_export);
				const len0 = WASM_VECTOR_LEN;
				wasm.transportengine_pushStream(retptr, this.__wbg_ptr, stream, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* Feed one network chunk on the default stream, for a caller reading one
		* response at a time.
		* @param {Uint8Array} chunk
		* @returns {any}
		*/
		push(chunk) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_export);
				const len0 = WASM_VECTOR_LEN;
				wasm.transportengine_push(retptr, this.__wbg_ptr, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		reset() {
			wasm.transportengine_reset(this.__wbg_ptr);
		}
		/**
		* Where playback should resume if this point is inside an ad.
		* @param {number} transport_us
		* @returns {number | undefined}
		*/
		resumeTarget(transport_us) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.transportengine_resumeTarget(retptr, this.__wbg_ptr, transport_us);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r2 = getDataViewMemory0().getFloat64(retptr + 8, true);
				return r0 === 0 ? void 0 : r2;
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* The video the viewer asked for. Changing it discards everything learned
		* about the previous stream.
		* @param {string} video_id
		*/
		setRequestedVideo(video_id) {
			const ptr0 = passStringToWasm0(video_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.transportengine_setRequestedVideo(this.__wbg_ptr, ptr0, len0);
		}
		/**
		* The MediaSource gate.
		* @param {number} transport_us
		* @returns {boolean}
		*/
		shouldAppend(transport_us) {
			return wasm.transportengine_shouldAppend(this.__wbg_ptr, transport_us) !== 0;
		}
		/**
		* Everything the diagnostics panel needs, in one call.
		* @returns {any}
		*/
		state() {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.transportengine_state(retptr, this.__wbg_ptr);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* The viewer's clock mapped back to transport time.
		* @param {number} content_us
		* @returns {number}
		*/
		transportTime(content_us) {
			return wasm.transportengine_transportTime(this.__wbg_ptr, content_us);
		}
		/**
		* @returns {string}
		*/
		verdict() {
			let deferred1_0;
			let deferred1_1;
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.transportengine_verdict(retptr, this.__wbg_ptr);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				deferred1_0 = r0;
				deferred1_1 = r1;
				return getStringFromWasm0(r0, r1);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
				wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
			}
		}
	};
	if (Symbol.dispose) TransportEngine.prototype[Symbol.dispose] = TransportEngine.prototype.free;
	function __wbg_get_imports() {
		return {
			__proto__: null,
			"./fad_yt_wasm_bg.js": {
				__proto__: null,
				__wbg_Error_67e7344beaa85059: function(arg0, arg1) {
					return addHeapObject(Error(getStringFromWasm0(arg0, arg1)));
				},
				__wbg_String_8564e559799eccda: function(arg0, arg1) {
					const ptr1 = passStringToWasm0(String(getObject(arg1)), wasm.__wbindgen_export, wasm.__wbindgen_export2);
					const len1 = WASM_VECTOR_LEN;
					getDataViewMemory0().setInt32(arg0 + 4, len1, true);
					getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
				},
				__wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
					throw new Error(getStringFromWasm0(arg0, arg1));
				},
				__wbg_error_3a1d0b2365a2c693: function(arg0, arg1) {
					console.error(getStringFromWasm0(arg0, arg1));
				},
				__wbg_new_bebc3f4757acf305: function() {
					return addHeapObject(/* @__PURE__ */ new Object());
				},
				__wbg_new_ffa92086ea89f79c: function() {
					return addHeapObject(new Array());
				},
				__wbg_set_13d25b81ab403f5e: function(arg0, arg1, arg2) {
					getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
				},
				__wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
					getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
				},
				__wbindgen_generic_0000000000000001: function(arg0) {
					return addHeapObject(arg0);
				},
				__wbindgen_generic_0000000000000002: function(arg0) {
					return addHeapObject(arg0);
				},
				__wbindgen_generic_0000000000000003: function(arg0, arg1) {
					return addHeapObject(getStringFromWasm0(arg0, arg1));
				},
				__wbindgen_generic_0000000000000004: function(arg0) {
					return addHeapObject(BigInt.asUintN(64, arg0));
				},
				__wbindgen_object_clone_ref: function(arg0) {
					return addHeapObject(getObject(arg0));
				},
				__wbindgen_object_drop_ref: function(arg0) {
					takeObject(arg0);
				}
			}
		};
	}
	var TransportEngineFinalization = typeof FinalizationRegistry === "undefined" ? {
		register: () => {},
		unregister: () => {}
	} : new FinalizationRegistry((ptr) => wasm.__wbg_transportengine_free(ptr, 1));
	function addHeapObject(obj) {
		if (heap_next === heap.length) heap.push(heap.length + 1);
		const idx = heap_next;
		heap_next = heap[idx];
		heap[idx] = obj;
		return idx;
	}
	function dropObject(idx) {
		if (idx < 1028) return;
		heap[idx] = heap_next;
		heap_next = idx;
	}
	var cachedDataViewMemory0 = null;
	function getDataViewMemory0() {
		if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
		return cachedDataViewMemory0;
	}
	function getStringFromWasm0(ptr, len) {
		return decodeText(ptr >>> 0, len);
	}
	var cachedUint8ArrayMemory0 = null;
	function getUint8ArrayMemory0() {
		if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
		return cachedUint8ArrayMemory0;
	}
	function getObject(idx) {
		return heap[idx];
	}
	var heap = new Array(1024).fill(void 0);
	heap.push(void 0, null, true, false);
	var heap_next = heap.length;
	function passArray8ToWasm0(arg, malloc) {
		const ptr = malloc(arg.length * 1, 1) >>> 0;
		getUint8ArrayMemory0().set(arg, ptr / 1);
		WASM_VECTOR_LEN = arg.length;
		return ptr;
	}
	function passStringToWasm0(arg, malloc, realloc) {
		if (realloc === void 0) {
			const buf = cachedTextEncoder.encode(arg);
			const ptr = malloc(buf.length, 1) >>> 0;
			getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
			WASM_VECTOR_LEN = buf.length;
			return ptr;
		}
		let len = arg.length;
		let ptr = malloc(len, 1) >>> 0;
		const mem = getUint8ArrayMemory0();
		let offset = 0;
		for (; offset < len; offset++) {
			const code = arg.charCodeAt(offset);
			if (code > 127) break;
			mem[ptr + offset] = code;
		}
		if (offset !== len) {
			if (offset !== 0) arg = arg.slice(offset);
			ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
			const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
			const ret = cachedTextEncoder.encodeInto(arg, view);
			offset += ret.written;
			ptr = realloc(ptr, len, offset, 1) >>> 0;
		}
		WASM_VECTOR_LEN = offset;
		return ptr;
	}
	function takeObject(idx) {
		const ret = getObject(idx);
		dropObject(idx);
		return ret;
	}
	var cachedTextDecoder = new TextDecoder("utf-8", {
		ignoreBOM: true,
		fatal: true
	});
	cachedTextDecoder.decode();
	var MAX_SAFARI_DECODE_BYTES = 2146435072;
	var numBytesDecoded = 0;
	function decodeText(ptr, len) {
		numBytesDecoded += len;
		if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
			cachedTextDecoder = new TextDecoder("utf-8", {
				ignoreBOM: true,
				fatal: true
			});
			cachedTextDecoder.decode();
			numBytesDecoded = len;
		}
		return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
	}
	var cachedTextEncoder = new TextEncoder();
	if (!("encodeInto" in cachedTextEncoder)) cachedTextEncoder.encodeInto = function(arg, view) {
		const buf = cachedTextEncoder.encode(arg);
		view.set(buf);
		return {
			read: arg.length,
			written: buf.length
		};
	};
	var WASM_VECTOR_LEN = 0;
	var wasm;
	function __wbg_finalize_init(instance, module) {
		wasm = instance.exports;
		cachedDataViewMemory0 = null;
		cachedUint8ArrayMemory0 = null;
		wasm.__wbindgen_start();
		return wasm;
	}
	async function __wbg_load(module, imports) {
		if (typeof Response === "function" && module instanceof Response) {
			if (!module.ok) throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
			if (typeof WebAssembly.instantiateStreaming === "function") try {
				return await WebAssembly.instantiateStreaming(module, imports);
			} catch (e) {
				if (expectedResponseType(module.type) && module.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
				else throw e;
			}
			const bytes = await module.arrayBuffer();
			return await WebAssembly.instantiate(bytes, imports);
		} else {
			const instance = await WebAssembly.instantiate(module, imports);
			if (instance instanceof WebAssembly.Instance) return {
				instance,
				module
			};
			else return instance;
		}
		function expectedResponseType(type) {
			switch (type) {
				case "basic":
				case "cors":
				case "default": return true;
			}
			return false;
		}
	}
	async function __wbg_init(module_or_path) {
		if (wasm !== void 0) return wasm;
		if (module_or_path !== void 0) {
			if (Object.getPrototypeOf(module_or_path) === Object.prototype) ({module_or_path} = module_or_path);
			else console.warn("using deprecated parameters for the initialization function; pass a single object instead");
		}
		if (module_or_path === void 0) module_or_path = (() => {
			throw new Error("404AD: pass module_or_path explicitly");
		})();
		const imports = __wbg_get_imports();
		if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) module_or_path = fetch(module_or_path);
		const { instance, module } = await __wbg_load(await module_or_path, imports);
		return __wbg_finalize_init(instance, module);
	}
	//#endregion
	//#region src/adapters/youtube-transport.ts
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
	var MEDIA_URL = /googlevideo\.com\/(video|init)playback/;
	/** Stop feeding a single response after this much, as a runaway guard. */
	var MAX_BYTES_PER_RESPONSE = 67108864;
	/** How often the skip state machine looks at the player. */
	var TICK_MS = 250;
	/** Seek only when the engine is this far past its threshold, in nats. */
	var SKIP_MARGIN_NATS = .5;
	var SECOND_US = 1e6;
	var engine = null;
	var loading = null;
	var installed = false;
	/**
	* Load the transport engine.
	*
	* Deliberately lazy: the module is only fetched once a SABR media request is
	* actually seen, so a YouTube page that never starts playback never pays for it
	* and no other site ever touches it.
	*/
	function loadEngine(wasmUrl) {
		loading ??= (async () => {
			await __wbg_init({ module_or_path: wasmUrl });
			engine = new TransportEngine();
			const videoId = currentVideoId();
			if (videoId) engine.setRequestedVideo(videoId);
			return engine;
		})();
		return loading;
	}
	function currentVideoId() {
		try {
			return new URL(location.href).searchParams.get("v");
		} catch {
			return null;
		}
	}
	/** The player element, if the page has one. */
	function player() {
		return document.querySelector("#movie_player");
	}
	function videoElement() {
		return document.querySelector("video.html5-main-video");
	}
	/**
	* Feed a response body to the engine without consuming it.
	*
	* `tee` gives two independent streams from one body: the page reads its branch
	* exactly as it would have, and 404AD reads the other. The page's playback path
	* is never in 404AD's critical path, so a slow or failed analysis cannot stall
	* the video.
	*
	* Each response gets its own engine stream. The player keeps several requests
	* in flight and cancels them mid-part constantly, so these read loops interleave
	* and end abruptly; a framing state shared between them would be reassembling
	* two responses out of one buffer.
	*/
	function observeBody(body, active) {
		const [toPage, toEngine] = body.tee();
		const stream = active.openStream();
		(async () => {
			const reader = toEngine.getReader();
			let total = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done || !value) break;
					total += value.byteLength;
					if (total > MAX_BYTES_PER_RESPONSE) break;
					try {
						active.pushStream(stream, value);
					} catch (error) {
						console.warn("404AD: transport parse stopped", error);
						break;
					}
				}
			} catch {} finally {
				reader.releaseLock();
				try {
					active.closeStream(stream);
				} catch {}
			}
		})();
		return toPage;
	}
	function urlOf(input) {
		if (typeof input === "string") return input;
		if (input instanceof URL) return input.href;
		return input.url;
	}
	function installFetchHook(wasmUrl) {
		const host = globalThis;
		const original = host.fetch;
		if (typeof original !== "function") return;
		host.fetch = async function transportFetch(input, init) {
			const response = await original.call(globalThis, input, init);
			if (!MEDIA_URL.test(urlOf(input)) || !response.body || !response.ok) return response;
			try {
				const active = engine ?? await loadEngine(wasmUrl);
				const toPage = observeBody(response.body, active);
				return new Response(toPage, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers
				});
			} catch (error) {
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
	function installBufferGate() {
		const proto = globalThis.SourceBuffer?.prototype;
		if (!proto) return;
		const originalAppend = proto.appendBuffer;
		proto.appendBuffer = function gatedAppend(data) {
			const active = engine;
			if (active) try {
				const ranges = this.buffered;
				const at = (ranges.length > 0 ? ranges.end(ranges.length - 1) : 0) * SECOND_US;
				const state = active.state();
				const confident = state.logLr >= state.upperThreshold + SKIP_MARGIN_NATS;
				const known = active.resumeTarget(at) !== void 0;
				if (confident && known && !active.shouldAppend(at)) return;
			} catch {}
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
	function installSkipLoop() {
		let lastReportedAdState = null;
		let lastSkipTarget = -1;
		const tick = () => {
			const active = engine;
			const video = videoElement();
			const element = player();
			if (!active || !video || !element) return;
			const showingAd = element.classList.contains("ad-showing");
			if (showingAd !== lastReportedAdState) {
				lastReportedAdState = showingAd;
				try {
					active.observe(showingAd ? "player-ad" : "player-content");
				} catch {}
			}
			if (!Number.isFinite(video.currentTime)) return;
			const at = video.currentTime * SECOND_US;
			const target = active.resumeTarget(at);
			if (target === void 0) return;
			const seconds = target / SECOND_US;
			if (Math.abs(seconds - lastSkipTarget) < .05) return;
			if (!Number.isFinite(video.duration) || seconds >= video.duration) return;
			lastSkipTarget = seconds;
			ourSeeks += 1;
			video.currentTime = seconds;
			if (video.paused) video.play().catch(() => void 0);
		};
		const timer = setInterval(tick, TICK_MS);
		return () => clearInterval(timer);
	}
	/** Seeks 404AD performed itself, which must not be reported back to it. */
	var ourSeeks = 0;
	/**
	* Tell the engine when the viewer scrubs.
	*
	* A scrub makes the server resume from somewhere else, which is indistinguishable
	* from a new media epoch by anything the transport can measure. Left unreported,
	* every drag of the scrubber charges a timeline discontinuity against the video.
	*
	* Captured on the document because media events do not bubble; the capture phase
	* still reaches a listener there, and one listener survives the player element
	* being replaced by a single-page navigation.
	*/
	function installSeekReporter() {
		const onSeeking = (event) => {
			if (!(event.target instanceof HTMLVideoElement)) return;
			if (ourSeeks > 0) {
				ourSeeks -= 1;
				return;
			}
			try {
				engine?.notifySeek();
			} catch {}
		};
		document.addEventListener("seeking", onSeeking, true);
		return () => document.removeEventListener("seeking", onSeeking, true);
	}
	/**
	* Install the transport engine.
	*
	* `wasmUrl` is an extension URL supplied by the content script. Nothing is
	* fetched from the network: the module is part of the package.
	*/
	function installTransport(wasmUrl) {
		if (installed || !wasmUrl) return;
		installed = true;
		installFetchHook(wasmUrl);
		installBufferGate();
		const stopLoop = installSkipLoop();
		const stopSeeks = installSeekReporter();
		globalThis.addEventListener("yt-navigate-finish", () => {
			const videoId = currentVideoId();
			if (engine && videoId) engine.setRequestedVideo(videoId);
		});
		globalThis.addEventListener("pagehide", () => {
			stopLoop();
			stopSeeks();
		}, { once: true });
		Object.defineProperty(globalThis, "__404AD_TRANSPORT__", {
			value: () => engine ? engine.state() : null,
			configurable: true,
			enumerable: false
		});
	}
	//#endregion
	//#region entrypoints/scriptlets-runtime.ts
	var REGISTRY = {
		...SCRIPTLETS,
		"404ad-yt-transport": (args) => installTransport(args[0] ?? ""),
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
