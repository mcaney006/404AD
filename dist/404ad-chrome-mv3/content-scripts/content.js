(function() {
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/define-content-script.mjs
	function defineContentScript(definition) {
		return definition;
	}
	//#endregion
	//#region src/content/cosmetic.ts
	/**
	* Cosmetic filtering in the content script.
	*
	* The expensive half of cosmetic filtering is deciding *which* of ~50k generic
	* selectors could possibly match a document. That decision happens in WASM in
	* the service worker; this file's job is to feed it the tokens it needs and to
	* apply what comes back.
	*
	* The flow is deliberately two-phase:
	*
	*  * At `document_start` the DOM is empty, so only host-specific rules can be
	*    applied. They go in immediately, before the page paints, which is what
	*    prevents the flash of an ad slot that later disappears.
	*  * Once content exists, the class and id tokens in the document are harvested
	*    and sent back for generic selection. New tokens introduced later by the
	*    page trigger an incremental round.
	*/
	var STYLE_ID = "404ad-cosmetic";
	var HIDE_DECLARATION = "display:none!important";
	/** Cap the token set so a pathological page cannot produce an unbounded message. */
	var MAX_TOKENS = 2e4;
	function isElement(node) {
		return node.nodeType === 1;
	}
	var CosmeticInjector = class {
		style = null;
		applied = /* @__PURE__ */ new Set();
		seenTokens = /* @__PURE__ */ new Set();
		/** Selectors currently hidden, used for the on-page count. */
		get selectorCount() {
			return this.applied.size;
		}
		/**
		* Add selectors to the injected stylesheet.
		*
		* One rule per selector rather than one grouped rule: an invalid selector in
		* a grouped rule invalidates every selector alongside it, so a single bad
		* filter would silently disable a whole batch.
		*/
		hide(selectors) {
			const fresh = selectors.filter((s) => s && !this.applied.has(s));
			if (fresh.length === 0) return 0;
			for (const s of fresh) this.applied.add(s);
			const css = fresh.map((s) => `${s}{${HIDE_DECLARATION}}`).join("\n");
			this.append(css);
			return fresh.length;
		}
		/** Add raw `selector { declarations }` rules from `#$#` filters. */
		addStyleRules(rules) {
			const fresh = rules.filter((r) => r && !this.applied.has(r));
			if (fresh.length === 0) return;
			for (const r of fresh) this.applied.add(r);
			this.append(fresh.join("\n"));
		}
		append(css) {
			if (!this.style || !this.style.isConnected) {
				this.style = document.createElement("style");
				this.style.id = STYLE_ID;
				this.style.setAttribute("type", "text/css");
				(document.head ?? document.documentElement).append(this.style);
			}
			this.style.append(document.createTextNode(`${css}\n`));
		}
		/** Remove everything this injector added. Used when a site is disabled. */
		reset() {
			this.style?.remove();
			this.style = null;
			this.applied.clear();
		}
		/**
		* Collect `.class` and `#id` tokens that have not been reported yet.
		*
		* Only the delta is returned: on a busy page the same few hundred tokens
		* recur constantly, and re-sending them would turn a cheap incremental pass
		* into a per-mutation round trip.
		*/
		harvestTokens(root = document) {
			if (this.seenTokens.size >= MAX_TOKENS) return [];
			const fresh = [];
			const consider = (token) => {
				if (this.seenTokens.has(token) || this.seenTokens.size >= MAX_TOKENS) return;
				this.seenTokens.add(token);
				fresh.push(token);
			};
			const scan = (element) => {
				const id = element.id;
				if (id) consider(`#${id}`);
				const className = element.getAttribute("class");
				if (!className) return;
				for (const part of className.split(/\s+/)) if (part) consider(`.${part}`);
			};
			if (isElement(root)) scan(root);
			for (const element of root.querySelectorAll("[class],[id]")) scan(element);
			return fresh;
		}
		/** How many elements the injected selectors actually match right now. */
		countHidden() {
			if (this.applied.size === 0) return 0;
			let total = 0;
			for (const selector of this.applied) {
				if (selector.includes("{")) continue;
				try {
					total += document.querySelectorAll(selector).length;
				} catch {}
			}
			return total;
		}
	};
	//#endregion
	//#region src/content/scriptlets.ts
	/**
	* Main-world scriptlet injection, from the content script.
	*
	* Scriptlets have to run in the page's own realm, and they need per-host
	* arguments. The obvious MV3 route is `chrome.scripting.executeScript` from the
	* service worker on a `webNavigation` event, and that route has a defect that
	* only shows up in a cold profile: the worker is not reliably awake when the
	* event fires, so the injection silently never happens. Cosmetic filtering was
	* unaffected because the content script wakes the worker itself with
	* `runtime.sendMessage`.
	*
	* So injection lives here instead, on the response the content script already
	* waits for. A `<script>` element pointing at a web-accessible extension
	* resource carries the config in a data attribute:
	*
	*   * nothing is evaluated from a string, and nothing is fetched remotely;
	*   * Chromium exempts extension-resource scripts injected by a content script
	*     from the page's own CSP, so this works on sites that forbid inline script;
	*   * it needs neither the `scripting` nor the `webNavigation` permission.
	*/
	var RUNTIME_PATH = "scriptlets-runtime.js";
	var TRANSPORT_WASM_PATH = "wasm/fad_yt_wasm_bg.wasm";
	/**
	* Supply arguments only the extension realm can produce.
	*
	* The main world has no `chrome` APIs, so a scriptlet that needs an extension
	* URL cannot build one. The content script fills it in here rather than the
	* runtime guessing, which also keeps the URL out of the filter list.
	*/
	function withRuntimeArgs(entry) {
		if (entry.name !== "404ad-yt-transport") return entry;
		return {
			...entry,
			args: [chrome.runtime.getURL(TRANSPORT_WASM_PATH), ...entry.args]
		};
	}
	var CONFIG_ATTRIBUTE = "data-404ad-scriptlets";
	var injected = false;
	function injectScriptlets(entries) {
		if (injected || entries.length === 0) return false;
		const active = entries.filter((entry) => !entry.shadow).map(withRuntimeArgs);
		if (active.length === 0) return false;
		injected = true;
		const element = document.createElement("script");
		element.src = chrome.runtime.getURL(RUNTIME_PATH);
		element.setAttribute(CONFIG_ATTRIBUTE, JSON.stringify(active));
		element.addEventListener("load", () => element.remove(), { once: true });
		(document.head ?? document.documentElement).append(element);
		return true;
	}
	//#endregion
	//#region src/content/procedural.ts
	/**
	* Procedural selector evaluation.
	*
	* `:has-text()`, `:upward()` and friends cannot be expressed in CSS, so they are
	* evaluated here against live elements. That makes them the most expensive part
	* of cosmetic filtering, which is why they are host-scoped at compile time and
	* why this engine is bounded on three axes:
	*
	*  * a candidate cap per rule, so a `*` prefix cannot walk a whole large DOM,
	*  * a time budget per pass, checked between rules,
	*  * idle scheduling, so a pass never competes with the page's own rendering.
	*/
	var MAX_CANDIDATES = 2e3;
	var TIME_BUDGET_MS = 12;
	var HIDDEN_ATTR = "data-404ad-hidden";
	function textOf(element) {
		return element.innerText ?? element.textContent ?? "";
	}
	function applyOp(elements, op) {
		if ("HasText" in op) {
			const { needle, regex } = op.HasText;
			if (regex) {
				let re;
				try {
					re = new RegExp(needle);
				} catch {
					return [];
				}
				return elements.filter((el) => re.test(textOf(el)));
			}
			return elements.filter((el) => textOf(el).includes(needle));
		}
		if ("Has" in op) {
			const selector = op.Has.selector;
			return elements.filter((el) => {
				try {
					return el.querySelector(selector) !== null;
				} catch {
					return false;
				}
			});
		}
		if ("Upward" in op) {
			const { steps, selector } = op.Upward;
			const out = [];
			for (const el of elements) {
				if (selector) {
					const found = el.closest(selector);
					if (found) out.push(found);
					continue;
				}
				let current = el;
				for (let i = 0; i < (steps ?? 0) && current; i += 1) current = current.parentElement;
				if (current) out.push(current);
			}
			return out;
		}
		if ("MatchesAttr" in op) {
			const { name, value } = op.MatchesAttr;
			return elements.filter((el) => {
				const actual = el.getAttribute(name);
				if (actual === null) return false;
				return value === null || actual === value;
			});
		}
		if ("MinTextLength" in op) {
			const min = op.MinTextLength.len;
			return elements.filter((el) => textOf(el).length >= min);
		}
		return [];
	}
	/** Evaluate one rule, returning the elements it selects. */
	function evaluate(entry, root = document) {
		let elements;
		try {
			elements = Array.from(root.querySelectorAll(entry.prefix ?? "*"));
		} catch {
			return [];
		}
		if (elements.length > MAX_CANDIDATES) elements = elements.slice(0, MAX_CANDIDATES);
		for (const op of entry.ops) {
			elements = applyOp(elements, op);
			if (elements.length === 0) break;
		}
		return elements;
	}
	var ProceduralEngine = class {
		entries = [];
		hidden = 0;
		scheduled = false;
		get hiddenCount() {
			return this.hidden;
		}
		setEntries(entries) {
			this.entries = entries.filter((e) => !e.shadow);
		}
		get isEmpty() {
			return this.entries.length === 0;
		}
		/** Coalesce bursts of mutations into one idle-time pass. */
		schedule() {
			if (this.scheduled || this.entries.length === 0) return;
			this.scheduled = true;
			const run = () => {
				this.scheduled = false;
				this.run();
			};
			if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 500 });
			else setTimeout(run, 100);
		}
		run() {
			const started = performance.now();
			let newlyHidden = 0;
			for (const entry of this.entries) {
				if (performance.now() - started > TIME_BUDGET_MS) break;
				for (const element of evaluate(entry)) {
					if (element.hasAttribute(HIDDEN_ATTR)) continue;
					element.setAttribute(HIDDEN_ATTR, String(entry.ruleId));
					element.style.setProperty("display", "none", "important");
					newlyHidden += 1;
				}
			}
			this.hidden += newlyHidden;
			return newlyHidden;
		}
		/** Undo every hide, for when a site is switched to relaxed or off. */
		reset() {
			for (const element of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
				element.style.removeProperty("display");
				element.removeAttribute(HIDDEN_ATTR);
			}
			this.hidden = 0;
		}
	};
	//#endregion
	//#region src/core/messaging.ts
	/**
	* Typed wrapper around `chrome.runtime.sendMessage`.
	*
	* Chrome resolves the promise with `undefined` and sets `lastError` when the
	* service worker is asleep or has thrown. Surfacing that as a rejection means
	* callers cannot accidentally treat a dropped message as an empty result.
	*/
	async function send(message) {
		const reply = await chrome.runtime.sendMessage(message);
		if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message ?? "message failed");
		if (reply === void 0) throw new Error(`404AD: no response to ${message.type}`);
		if (!reply.ok) throw new Error(reply.error);
		return reply.data;
	}
	/** Best-effort send for fire-and-forget notifications from content scripts. */
	function notify(message) {
		chrome.runtime.sendMessage(message).catch(() => {});
	}
	//#endregion
	//#region entrypoints/content.ts
	/**
	* The content runtime.
	*
	* Runs in every frame at `document_start`. It does three things and nothing
	* else: apply host-specific cosmetic rules before first paint, feed DOM tokens
	* back for generic selection, and evaluate procedural selectors as the page
	* changes. It never touches the network path.
	*/
	var content_default = defineContentScript({
		matches: ["<all_urls>"],
		runAt: "document_start",
		allFrames: true,
		async main() {
			const host = location.hostname;
			if (!host) return;
			const injector = new CosmeticInjector();
			const procedural = new ProceduralEngine();
			let reportedHidden = 0;
			let payload;
			try {
				payload = await send({
					type: "document:resolve",
					host,
					tokens: []
				});
			} catch {
				return;
			}
			if (payload.scriptletsEnabled) injectScriptlets(payload.scriptlets);
			if (!payload.cosmeticEnabled) return;
			injector.hide(payload.specific);
			injector.addStyleRules(payload.styles);
			procedural.setEntries(payload.procedural);
			let unhideIds = payload.unhideIds;
			let pending = [];
			let flushTimer = null;
			const flushTokens = async () => {
				flushTimer = null;
				const tokens = pending;
				pending = [];
				if (tokens.length === 0) return;
				try {
					const { generic } = await send({
						type: "document:generic",
						host,
						tokens,
						unhideIds
					});
					injector.hide(generic);
				} catch {}
			};
			const scheduleTokenFlush = () => {
				if (flushTimer !== null) return;
				flushTimer = setTimeout(() => void flushTokens(), 60);
			};
			const harvest = (root = document) => {
				const tokens = injector.harvestTokens(root);
				if (tokens.length === 0) return;
				pending.push(...tokens);
				scheduleTokenFlush();
			};
			const reportHidden = () => {
				const total = injector.countHidden() + procedural.hiddenCount;
				if (total === reportedHidden) return;
				notify({
					type: "content:hidden",
					count: total - reportedHidden
				});
				reportedHidden = total;
			};
			const observer = new MutationObserver((records) => {
				for (const record of records) {
					for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) harvest(node);
					if (record.type === "attributes" && record.target.nodeType === Node.ELEMENT_NODE) harvest(record.target);
				}
				procedural.schedule();
			});
			const start = () => {
				harvest();
				procedural.run();
				reportHidden();
				observer.observe(document.documentElement, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["class", "id"]
				});
			};
			if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
			else start();
			const counter = setInterval(reportHidden, 1e3);
			addEventListener("pagehide", () => {
				observer.disconnect();
				clearInterval(counter);
				if (flushTimer !== null) clearTimeout(flushTimer);
			}, { once: true });
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area !== "local" || !("sites" in changes || "settings" in changes)) return;
				(async () => {
					const next = await send({
						type: "document:resolve",
						host,
						tokens: []
					});
					if (next.scriptletsEnabled) injectScriptlets(next.scriptlets);
					if (!next.cosmeticEnabled) {
						injector.reset();
						procedural.reset();
						procedural.setEntries([]);
						return;
					}
					unhideIds = next.unhideIds;
					injector.hide(next.specific);
					injector.addStyleRules(next.styles);
					procedural.setEntries(next.procedural);
					procedural.schedule();
				})().catch(() => void 0);
			});
		}
	});
	//#endregion
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/internal/logger.mjs
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger$1 = {
		debug: (...args) => ([...args], void 0),
		log: (...args) => ([...args], void 0),
		warn: (...args) => ([...args], void 0),
		error: (...args) => ([...args], void 0)
	};
	//#endregion
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/browser.mjs
	/**
	* Contains the `browser` export which you should use to access the extension
	* APIs in your project:
	*
	* ```ts
	* import { browser } from 'wxt/browser';
	*
	* browser.runtime.onInstalled.addListener(() => {
	*   // ...
	* });
	* ```
	*
	* @module wxt/browser
	*/
	var browser = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
	//#endregion
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/internal/custom-events.mjs
	var WxtLocationChangeEvent = class WxtLocationChangeEvent extends Event {
		static EVENT_NAME = getUniqueEventName("wxt:locationchange");
		constructor(newUrl, oldUrl) {
			super(WxtLocationChangeEvent.EVENT_NAME, {});
			this.newUrl = newUrl;
			this.oldUrl = oldUrl;
		}
	};
	/**
	* Returns an event name unique to the extension and content script that's
	* running.
	*/
	function getUniqueEventName(eventName) {
		return `${browser?.runtime?.id}:content:${eventName}`;
	}
	//#endregion
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/internal/location-watcher.mjs
	var supportsNavigationApi = typeof globalThis.navigation?.addEventListener === "function";
	/**
	* Create a util that watches for URL changes, dispatching the custom event when
	* detected. Stops watching when content script is invalidated. Uses Navigation
	* API when available, otherwise falls back to polling.
	*/
	function createLocationWatcher(ctx) {
		let lastUrl;
		let watching = false;
		return { run() {
			if (watching) return;
			watching = true;
			lastUrl = new URL(location.href);
			if (supportsNavigationApi) globalThis.navigation.addEventListener("navigate", (event) => {
				const newUrl = new URL(event.destination.url);
				if (newUrl.href === lastUrl.href) return;
				window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
				lastUrl = newUrl;
			}, { signal: ctx.signal });
			else ctx.setInterval(() => {
				const newUrl = new URL(location.href);
				if (newUrl.href !== lastUrl.href) {
					window.dispatchEvent(new WxtLocationChangeEvent(newUrl, lastUrl));
					lastUrl = newUrl;
				}
			}, 1e3);
		} };
	}
	//#endregion
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/content-script-context.mjs
	/**
	* Implements
	* [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController).
	* Used to detect and stop content script code when the script is invalidated.
	*
	* It also provides several utilities like `ctx.setTimeout` and
	* `ctx.setInterval` that should be used in content scripts instead of
	* `window.setTimeout` or `window.setInterval`.
	*
	* To create context for testing, you can use the class's constructor:
	*
	* ```ts
	* import { ContentScriptContext } from 'wxt/utils/content-scripts-context';
	*
	* test('storage listener should be removed when context is invalidated', () => {
	*   const ctx = new ContentScriptContext('test');
	*   const item = storage.defineItem('local:count', { defaultValue: 0 });
	*   const watcher = vi.fn();
	*
	*   const unwatch = item.watch(watcher);
	*   ctx.onInvalidated(unwatch); // Listen for invalidate here
	*
	*   await item.setValue(1);
	*   expect(watcher).toBeCalledTimes(1);
	*   expect(watcher).toBeCalledWith(1, 0);
	*
	*   ctx.notifyInvalidated(); // Use this function to invalidate the context
	*   await item.setValue(2);
	*   expect(watcher).toBeCalledTimes(1);
	* });
	* ```
	*/
	var ContentScriptContext = class ContentScriptContext {
		static SCRIPT_STARTED_MESSAGE_TYPE = getUniqueEventName("wxt:content-script-started");
		id;
		abortController;
		locationWatcher = createLocationWatcher(this);
		constructor(contentScriptName, options) {
			this.contentScriptName = contentScriptName;
			this.options = options;
			this.id = Math.random().toString(36).slice(2);
			this.abortController = new AbortController();
			this.stopOldScripts();
			this.listenForNewerScripts();
		}
		get signal() {
			return this.abortController.signal;
		}
		abort(reason) {
			return this.abortController.abort(reason);
		}
		get isInvalid() {
			if (browser.runtime?.id == null) this.notifyInvalidated();
			return this.signal.aborted;
		}
		get isValid() {
			return !this.isInvalid;
		}
		/**
		* Add a listener that is called when the content script's context is
		* invalidated.
		*
		* @example
		*   browser.runtime.onMessage.addListener(cb);
		*   const removeInvalidatedListener = ctx.onInvalidated(() => {
		*     browser.runtime.onMessage.removeListener(cb);
		*   });
		*   // ...
		*   removeInvalidatedListener();
		*
		* @returns A function to remove the listener.
		*/
		onInvalidated(cb) {
			this.signal.addEventListener("abort", cb);
			return () => this.signal.removeEventListener("abort", cb);
		}
		/**
		* Return a promise that never resolves. Useful if you have an async function
		* that shouldn't run after the context is expired.
		*
		* @example
		*   const getValueFromStorage = async () => {
		*     if (ctx.isInvalid) return ctx.block();
		*
		*     // ...
		*   };
		*/
		block() {
			return new Promise(() => {});
		}
		/**
		* Wrapper around `window.setInterval` that automatically clears the interval
		* when invalidated.
		*
		* Intervals can be cleared by calling the normal `clearInterval` function.
		*/
		setInterval(handler, timeout) {
			const id = setInterval(() => {
				if (this.isValid) handler();
			}, timeout);
			this.onInvalidated(() => clearInterval(id));
			return id;
		}
		/**
		* Wrapper around `window.setTimeout` that automatically clears the interval
		* when invalidated.
		*
		* Timeouts can be cleared by calling the normal `setTimeout` function.
		*/
		setTimeout(handler, timeout) {
			const id = setTimeout(() => {
				if (this.isValid) handler();
			}, timeout);
			this.onInvalidated(() => clearTimeout(id));
			return id;
		}
		/**
		* Wrapper around `window.requestAnimationFrame` that automatically cancels
		* the request when invalidated.
		*
		* Callbacks can be canceled by calling the normal `cancelAnimationFrame`
		* function.
		*/
		requestAnimationFrame(callback) {
			const id = requestAnimationFrame((...args) => {
				if (this.isValid) callback(...args);
			});
			this.onInvalidated(() => cancelAnimationFrame(id));
			return id;
		}
		/**
		* Wrapper around `window.requestIdleCallback` that automatically cancels the
		* request when invalidated.
		*
		* Callbacks can be canceled by calling the normal `cancelIdleCallback`
		* function.
		*/
		requestIdleCallback(callback, options) {
			const id = requestIdleCallback((...args) => {
				if (!this.signal.aborted) callback(...args);
			}, options);
			this.onInvalidated(() => cancelIdleCallback(id));
			return id;
		}
		addEventListener(target, type, handler, options) {
			if (type === "wxt:locationchange") {
				if (this.isValid) this.locationWatcher.run();
			}
			target.addEventListener?.(type.startsWith("wxt:") ? getUniqueEventName(type) : type, handler, {
				...options,
				signal: this.signal
			});
		}
		/**
		* @internal
		* Abort the abort controller and execute all `onInvalidated` listeners.
		*/
		notifyInvalidated() {
			this.abort("Content script context invalidated");
			logger$1.debug(`Content script "${this.contentScriptName}" context invalidated`);
		}
		stopOldScripts() {
			document.dispatchEvent(new CustomEvent(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, { detail: {
				contentScriptName: this.contentScriptName,
				messageId: this.id
			} }));
			if (!this.options?.noScriptStartedPostMessage) window.postMessage({
				type: ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE,
				contentScriptName: this.contentScriptName,
				messageId: this.id
			}, "*");
		}
		verifyScriptStartedEvent(event) {
			const isSameContentScript = event.detail?.contentScriptName === this.contentScriptName;
			const isFromSelf = event.detail?.messageId === this.id;
			return isSameContentScript && !isFromSelf;
		}
		listenForNewerScripts() {
			const cb = (event) => {
				if (!(event instanceof CustomEvent) || !this.verifyScriptStartedEvent(event)) return;
				this.notifyInvalidated();
			};
			document.addEventListener(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, cb);
			this.onInvalidated(() => document.removeEventListener(ContentScriptContext.SCRIPT_STARTED_MESSAGE_TYPE, cb));
		}
	};
	//#endregion
	//#region \0virtual:wxt-content-script-isolated-world-entrypoint?/Users/michael.jr/Developer/404AD/packages/extension/entrypoints/content.ts
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => ([...args], void 0),
		log: (...args) => ([...args], void 0),
		warn: (...args) => ([...args], void 0),
		error: (...args) => ([...args], void 0)
	};
	//#endregion
	return (async () => {
		try {
			const { main, ...options } = content_default;
			return await main(new ContentScriptContext("content", options));
		} catch (err) {
			logger.error(`The content script "content" crashed on startup!`, err);
			throw err;
		}
	})();
})();
