var background = (function() {
	//#region ../../node_modules/.bun/wxt@0.21.4+6046911b96bd7817/node_modules/wxt/dist/utils/define-background.mjs
	function defineBackground(arg) {
		if (arg == null || typeof arg === "function") return { main: arg };
		return arg;
	}
	//#endregion
	//#region src/core/diagnostics.ts
	var loading = null;
	function loadDiagnostics() {
		loading ??= fetch(chrome.runtime.getURL("generated/diagnostics.json")).then((r) => r.json());
		return loading;
	}
	async function ruleMeta(ruleId) {
		return (await loadDiagnostics()).network[String(ruleId)] ?? null;
	}
	/** DNR rule id -> the fields statistics needs, as one map. */
	async function ruleMetaMap() {
		const file = await loadDiagnostics();
		const out = /* @__PURE__ */ new Map();
		for (const [id, d] of Object.entries(file.network)) out.set(Number(id), {
			raw: d.raw,
			list: d.list,
			shadow: d.shadow,
			riskScore: d.riskScore,
			riskBand: d.riskBand
		});
		return out;
	}
	async function shadowRuleIds() {
		const file = await loadDiagnostics();
		const out = /* @__PURE__ */ new Set();
		for (const [id, d] of Object.entries(file.network)) if (d.shadow) out.add(Number(id));
		return out;
	}
	/**
	* A bounded ring of recent matches per tab.
	*
	* Kept in worker memory only. Diagnostics are for the page in front of you, so
	* persisting them would trade privacy for no benefit.
	*/
	var RING_SIZE = 200;
	var rings = /* @__PURE__ */ new Map();
	function recordMatch(tabId, match) {
		if (tabId < 0) return;
		const ring = rings.get(tabId) ?? [];
		ring.push(match);
		if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
		rings.set(tabId, ring);
	}
	function recentMatches(tabId) {
		return (rings.get(tabId) ?? []).toReversed();
	}
	function clearTab(tabId) {
		rings.delete(tabId);
	}
	function tabBlockedCount(tabId) {
		return (rings.get(tabId) ?? []).filter((m) => !m.shadow).length;
	}
	function tabShadowCount(tabId) {
		return (rings.get(tabId) ?? []).filter((m) => m.shadow).length;
	}
	//#endregion
	//#region src/wasm/fad_wasm.js
	var CosmeticEngine = class {
		__destroy_into_raw() {
			const ptr = this.__wbg_ptr;
			this.__wbg_ptr = 0;
			CosmeticEngineFinalization.unregister(this);
			return ptr;
		}
		free() {
			const ptr = this.__destroy_into_raw();
			wasm.__wbg_cosmeticengine_free(ptr, 0);
		}
		/**
		* @returns {string}
		*/
		buildId() {
			let deferred1_0;
			let deferred1_1;
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.cosmeticengine_buildId(retptr, this.__wbg_ptr);
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
		/**
		* Host-specific rules: hide selectors, styles, scriptlets and procedural
		* selectors, with every exception already subtracted.
		* @param {string} hostname
		* @returns {any}
		*/
		lookupHost(hostname) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passStringToWasm0(hostname, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len0 = WASM_VECTOR_LEN;
				wasm.cosmeticengine_lookupHost(retptr, this.__wbg_ptr, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* Load a `cosmetic.bin` produced by `fad-compile build`.
		* @param {Uint8Array} bytes
		*/
		constructor(bytes) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
				const len0 = WASM_VECTOR_LEN;
				wasm.cosmeticengine_new(retptr, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				this.__wbg_ptr = r0;
				CosmeticEngineFinalization.register(this, this.__wbg_ptr, this);
				return this;
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* One call for the common case: everything a content script needs on load.
		* @param {string} hostname
		* @param {string[]} tokens
		* @returns {any}
		*/
		resolveDocument(hostname, tokens) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passStringToWasm0(hostname, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len0 = WASM_VECTOR_LEN;
				const ptr1 = passArrayJsValueToWasm0(tokens, wasm.__wbindgen_export);
				const len1 = WASM_VECTOR_LEN;
				wasm.cosmeticengine_resolveDocument(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* Generic selectors gated on the tokens actually present in the document.
		*
		* `tokens` are `.class` / `#id` strings harvested from the live DOM;
		* `unhide_ids` comes from the `unhideIds` field of [`Self::lookup_host`].
		* @param {string[]} tokens
		* @param {Uint32Array} unhide_ids
		* @returns {string[]}
		*/
		selectGeneric(tokens, unhide_ids) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passArrayJsValueToWasm0(tokens, wasm.__wbindgen_export);
				const len0 = WASM_VECTOR_LEN;
				const ptr1 = passArray32ToWasm0(unhide_ids, wasm.__wbindgen_export);
				const len1 = WASM_VECTOR_LEN;
				wasm.cosmeticengine_selectGeneric(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				var v3 = getArrayJsValueFromWasm0(r0, r1);
				wasm.__wbindgen_export3(r0, r1 * 4, 4);
				return v3;
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* @returns {any}
		*/
		stats() {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				wasm.cosmeticengine_stats(retptr, this.__wbg_ptr);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
	};
	if (Symbol.dispose) CosmeticEngine.prototype[Symbol.dispose] = CosmeticEngine.prototype.free;
	var DiagnosticsEngine = class {
		__destroy_into_raw() {
			const ptr = this.__wbg_ptr;
			this.__wbg_ptr = 0;
			DiagnosticsEngineFinalization.unregister(this);
			return ptr;
		}
		free() {
			const ptr = this.__destroy_into_raw();
			wasm.__wbg_diagnosticsengine_free(ptr, 0);
		}
		/**
		* Explain what the rule set does with one request, and why.
		*
		* Returns every matching rule, not just the winner: the useful question is
		* usually "what else nearly matched", especially when a page broke.
		* @param {string} url
		* @param {string} initiator
		* @param {string} resource_type
		* @returns {any}
		*/
		explain(url, initiator, resource_type) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len0 = WASM_VECTOR_LEN;
				const ptr1 = passStringToWasm0(initiator, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len1 = WASM_VECTOR_LEN;
				const ptr2 = passStringToWasm0(resource_type, wasm.__wbindgen_export, wasm.__wbindgen_export2);
				const len2 = WASM_VECTOR_LEN;
				wasm.diagnosticsengine_explain(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				return takeObject(r0);
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* Load a `network-ir.bin` produced by `fad-compile build`.
		* @param {Uint8Array} bytes
		*/
		constructor(bytes) {
			try {
				const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
				const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
				const len0 = WASM_VECTOR_LEN;
				wasm.diagnosticsengine_new(retptr, ptr0, len0);
				var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
				var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
				if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
				this.__wbg_ptr = r0;
				DiagnosticsEngineFinalization.register(this, this.__wbg_ptr, this);
				return this;
			} finally {
				wasm.__wbindgen_add_to_stack_pointer(16);
			}
		}
		/**
		* @returns {number}
		*/
		ruleCount() {
			return wasm.diagnosticsengine_ruleCount(this.__wbg_ptr) >>> 0;
		}
	};
	if (Symbol.dispose) DiagnosticsEngine.prototype[Symbol.dispose] = DiagnosticsEngine.prototype.free;
	/**
	* Compile user filters into DNR rules the extension can register dynamically.
	*
	* Ids start at `id_base` so they cannot collide with the static rulesets.
	* @param {string} text
	* @param {number} id_base
	* @param {boolean} shadow
	* @returns {any}
	*/
	function compileUserFilters$1(text, id_base, shadow) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.compileUserFilters(retptr, ptr0, len0, id_base, shadow);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			return takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* Parse and score custom filters, one line at a time.
	*
	* Nothing is rejected outright. A malformed line is reported with its reason
	* and a dangerous one is flagged, but the user stays in control of both.
	* @param {string} text
	* @returns {any}
	*/
	function validateFilters$1(text) {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
			const len0 = WASM_VECTOR_LEN;
			wasm.validateFilters(retptr, ptr0, len0);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			return takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	function __wbg_get_imports() {
		return {
			__proto__: null,
			"./fad_wasm_bg.js": {
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
				__wbg___wbindgen_is_string_c4f7cb494a2a21f1: function(arg0) {
					return typeof getObject(arg0) === "string";
				},
				__wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
					const obj = getObject(arg1);
					const ret = typeof obj === "string" ? obj : void 0;
					var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
					var len1 = WASM_VECTOR_LEN;
					getDataViewMemory0().setInt32(arg0 + 4, len1, true);
					getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
				},
				__wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
					throw new Error(getStringFromWasm0(arg0, arg1));
				},
				__wbg_error_15c7318d411c8128: function(arg0, arg1) {
					console.error(getStringFromWasm0(arg0, arg1));
				},
				__wbg_new_8d36e20aa758e411: function() {
					return addHeapObject(/* @__PURE__ */ new Map());
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
				__wbg_set_bf6dde4923b9b059: function(arg0, arg1, arg2) {
					return addHeapObject(getObject(arg0).set(getObject(arg1), getObject(arg2)));
				},
				__wbindgen_generic_0000000000000001: function(arg0) {
					return addHeapObject(arg0);
				},
				__wbindgen_generic_0000000000000002: function(arg0, arg1) {
					return addHeapObject(getStringFromWasm0(arg0, arg1));
				},
				__wbindgen_generic_0000000000000003: function(arg0) {
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
	var CosmeticEngineFinalization = typeof FinalizationRegistry === "undefined" ? {
		register: () => {},
		unregister: () => {}
	} : new FinalizationRegistry((ptr) => wasm.__wbg_cosmeticengine_free(ptr, 1));
	var DiagnosticsEngineFinalization = typeof FinalizationRegistry === "undefined" ? {
		register: () => {},
		unregister: () => {}
	} : new FinalizationRegistry((ptr) => wasm.__wbg_diagnosticsengine_free(ptr, 1));
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
	function getArrayJsValueFromWasm0(ptr, len) {
		ptr = ptr >>> 0;
		const mem = getDataViewMemory0();
		const result = [];
		for (let i = ptr; i < ptr + 4 * len; i += 4) result.push(takeObject(mem.getUint32(i, true)));
		return result;
	}
	var cachedDataViewMemory0 = null;
	function getDataViewMemory0() {
		if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
		return cachedDataViewMemory0;
	}
	function getStringFromWasm0(ptr, len) {
		return decodeText(ptr >>> 0, len);
	}
	var cachedUint32ArrayMemory0 = null;
	function getUint32ArrayMemory0() {
		if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
		return cachedUint32ArrayMemory0;
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
	function isLikeNone(x) {
		return x === void 0 || x === null;
	}
	function passArray32ToWasm0(arg, malloc) {
		const ptr = malloc(arg.length * 4, 4) >>> 0;
		getUint32ArrayMemory0().set(arg, ptr / 4);
		WASM_VECTOR_LEN = arg.length;
		return ptr;
	}
	function passArray8ToWasm0(arg, malloc) {
		const ptr = malloc(arg.length * 1, 1) >>> 0;
		getUint8ArrayMemory0().set(arg, ptr / 1);
		WASM_VECTOR_LEN = arg.length;
		return ptr;
	}
	function passArrayJsValueToWasm0(array, malloc) {
		const ptr = malloc(array.length * 4, 4) >>> 0;
		const mem = getDataViewMemory0();
		for (let i = 0; i < array.length; i++) mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
		WASM_VECTOR_LEN = array.length;
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
		cachedUint32ArrayMemory0 = null;
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
	//#region src/core/engine.ts
	/**
	* The WASM facade, owned exclusively by the service worker.
	*
	* Content scripts ask the worker for their cosmetic payload rather than loading
	* the runtime themselves: the module is ~1.5 MB and a page can have dozens of
	* frames. One instance per browser session, not one per frame.
	*
	* The heavy diagnostics engine is loaded separately and only on first use,
	* because most sessions never open the inspector.
	*/
	var ready = null;
	var cosmetic = null;
	var diagnostics = null;
	var diagnosticsReady = null;
	var lastError = null;
	async function fetchBytes(path) {
		const response = await fetch(chrome.runtime.getURL(path));
		if (!response.ok) throw new Error(`${path}: ${response.status} ${response.statusText}`);
		return new Uint8Array(await response.arrayBuffer());
	}
	/**
	* Initialise the WASM module and the cosmetic index.
	*
	* The binary is always read from the packaged extension. 404AD never loads
	* executable code over the network, which is also why the module is fetched by
	* `chrome.runtime.getURL` rather than by a bundler-generated absolute path.
	*/
	function initEngine() {
		ready ??= (async () => {
			try {
				await __wbg_init({ module_or_path: chrome.runtime.getURL("wasm/fad_wasm_bg.wasm") });
				cosmetic = new CosmeticEngine(await fetchBytes("generated/cosmetic.bin"));
				lastError = null;
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				ready = null;
				throw error;
			}
		})();
		return ready;
	}
	async function cosmeticEngine() {
		await initEngine();
		if (!cosmetic) throw new Error("cosmetic engine unavailable");
		return cosmetic;
	}
	/** Load the diagnostics engine on first use. */
	async function diagnosticsEngine() {
		diagnosticsReady ??= (async () => {
			await initEngine();
			diagnostics = new DiagnosticsEngine(await fetchBytes("generated/network-ir.bin"));
			return diagnostics;
		})();
		return diagnosticsReady;
	}
	/** Everything a content script needs for one document, in one WASM call. */
	async function resolveDocument(host, tokens) {
		return (await cosmeticEngine()).resolveDocument(host, tokens);
	}
	/**
	* Second-pass generic selection.
	*
	* The first pass runs at `document_start`, when the DOM is empty and no tokens
	* exist yet. This is called once the document has content, and again when a
	* mutation introduces tokens that were not present before.
	*/
	async function selectGeneric(tokens, unhideIds) {
		return (await cosmeticEngine()).selectGeneric(tokens, new Uint32Array(unhideIds));
	}
	async function explain(url, initiator, resourceType) {
		return (await diagnosticsEngine()).explain(url, initiator, resourceType);
	}
	async function validateFilters(text) {
		await initEngine();
		return validateFilters$1(text);
	}
	async function compileUserFilters(text, idBase, shadow) {
		await initEngine();
		return compileUserFilters$1(text, idBase, shadow);
	}
	async function engineStats() {
		try {
			return (await cosmeticEngine()).stats();
		} catch {
			return null;
		}
	}
	function engineError() {
		return lastError;
	}
	function isReady() {
		return cosmetic !== null;
	}
	//#endregion
	//#region src/core/settings.ts
	var KEY$2 = "settings";
	var DEFAULT_SETTINGS = {
		enabled: true,
		rulesets: {},
		cosmeticFiltering: true,
		scriptlets: true,
		statistics: true,
		shadowMode: true,
		userFilters: "",
		confirmedRiskyFilters: []
	};
	var cache$1 = null;
	/**
	* Read settings, filling in any key added since the profile was written.
	*
	* The service worker is torn down constantly, so this caches in module scope
	* and is invalidated by {@link saveSettings} and by the storage listener below.
	*/
	async function loadSettings() {
		if (cache$1) return cache$1;
		const stored = await chrome.storage.local.get(KEY$2);
		cache$1 = {
			...DEFAULT_SETTINGS,
			...stored[KEY$2]
		};
		return cache$1;
	}
	async function saveSettings(patch) {
		const next = {
			...await loadSettings(),
			...patch
		};
		cache$1 = next;
		await chrome.storage.local.set({ [KEY$2]: next });
		return next;
	}
	/**
	* Invalidate the cache when another extension context writes.
	*
	* Guarded because this module is also exercised outside an extension realm (unit
	* tests, and any future non-Chromium host). Registering a listener at import
	* time is a side effect; refusing to crash without the API is the price of
	* keeping the module importable.
	*/
	function onStorageChanged(key, invalidate) {
		if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area === "local" && key in changes) invalidate();
		});
	}
	onStorageChanged(KEY$2, () => {
		cache$1 = null;
	});
	//#endregion
	//#region src/core/rulesets.ts
	var manifestRulesets = null;
	async function availableRulesets() {
		if (manifestRulesets) return manifestRulesets;
		manifestRulesets = await (await fetch(chrome.runtime.getURL("generated/rulesets.json"))).json();
		return manifestRulesets;
	}
	/**
	* Apply the user's ruleset choices.
	*
	* Chromium rejects the whole call if it names an unknown ruleset id, so the
	* requested sets are intersected with what the manifest actually declares. A
	* stale id left over from an older build must not brick rule loading.
	*/
	async function syncRulesets() {
		const [settings, available] = await Promise.all([loadSettings(), availableRulesets()]);
		const known = new Set(available.map((r) => r.id));
		const choices = { ...settings.rulesets };
		let changed = false;
		for (const ruleset of available) if (!(ruleset.id in choices)) {
			choices[ruleset.id] = ruleset.enabled;
			changed = true;
		}
		for (const id of Object.keys(choices)) if (!known.has(id)) {
			delete choices[id];
			changed = true;
		}
		if (changed) await saveSettings({ rulesets: choices });
		const masterOff = !settings.enabled;
		const wanted = new Set(masterOff ? [] : available.filter((r) => choices[r.id] ?? r.enabled).map((r) => r.id));
		const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
		const enableRulesetIds = [...wanted].filter((id) => !current.has(id));
		const disableRulesetIds = [...current].filter((id) => !wanted.has(id));
		if (enableRulesetIds.length > 0 || disableRulesetIds.length > 0) await chrome.declarativeNetRequest.updateEnabledRulesets({
			enableRulesetIds,
			disableRulesetIds
		});
		return [...wanted].sort();
	}
	//#endregion
	//#region src/core/sites.ts
	var KEY$1 = "sites";
	/**
	* Session rule ids for per-site disabling.
	*
	* Session rules live in their own id namespace, separate from both static and
	* dynamic rules, so this range cannot collide with anything else.
	*/
	var SITE_RULE_BASE = 1;
	/**
	* Priority for a per-site `allowAllRequests`.
	*
	* Above every static priority, including `$important` blocks: turning 404AD off
	* for a site has to mean *off*, not "off unless a list author disagreed".
	*/
	var SITE_DISABLE_PRIORITY = 1e3;
	var cache = null;
	async function loadSites() {
		if (cache) return cache;
		cache = (await chrome.storage.local.get(KEY$1))[KEY$1] ?? [];
		return cache;
	}
	/** All suffixes of a host with at least two labels, most specific first. */
	function hostSuffixes(host) {
		const clean = host.replace(/\.$/, "").toLowerCase();
		const out = [];
		let current = clean;
		while (current.includes(".")) {
			out.push(current);
			const next = current.slice(current.indexOf(".") + 1);
			if (!next.includes(".")) break;
			current = next;
		}
		if (out.length === 0 && clean) out.push(clean);
		return out;
	}
	/**
	* The mode in force for a host.
	*
	* The most specific rule wins, so `off` on `app.example.com` survives a
	* `default` on `example.com`.
	*/
	async function resolveMode(host) {
		const sites = await loadSites();
		if (sites.length === 0) return "default";
		const byHost = new Map(sites.map((s) => [s.host, s.mode]));
		for (const suffix of hostSuffixes(host)) {
			const mode = byHost.get(suffix);
			if (mode) return mode;
		}
		return "default";
	}
	async function setSiteMode(host, mode) {
		const next = (await loadSites()).filter((s) => s.host !== host);
		if (mode !== "default") next.push({
			host,
			mode,
			updatedAt: Date.now()
		});
		next.sort((a, b) => a.host.localeCompare(b.host));
		cache = next;
		await chrome.storage.local.set({ [KEY$1]: next });
		await syncSessionRules(next);
		return next;
	}
	/**
	* Mirror `off` sites into session DNR rules.
	*
	* Session rules are cheap, are never persisted to disk, and are rebuilt on every
	* worker start, which is exactly right for something derived from storage.
	*/
	async function syncSessionRules(sites) {
		const disabled = (sites ?? await loadSites()).filter((s) => s.mode === "off");
		const removeRuleIds = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
		const addRules = disabled.map((site, i) => ({
			id: SITE_RULE_BASE + i,
			priority: SITE_DISABLE_PRIORITY,
			action: { type: "allowAllRequests" },
			condition: {
				urlFilter: `||${site.host}^`,
				resourceTypes: ["main_frame", "sub_frame"]
			}
		}));
		await chrome.declarativeNetRequest.updateSessionRules({
			removeRuleIds,
			addRules
		});
	}
	/**
	* Invalidate the cache when another extension context writes.
	*
	* Guarded so the module stays importable outside an extension realm, which is
	* how `hostSuffixes` and `resolveMode` are unit tested.
	*/
	if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && KEY$1 in changes) cache = null;
	});
	//#endregion
	//#region src/core/stats.ts
	/**
	* Local-only adaptive statistics.
	*
	* Everything here stays in `chrome.storage.local`. The numbers exist to answer
	* three questions the user or the maintainer can act on:
	*
	*  * How much is being blocked, and where?
	*  * Which rules have never matched? (prune candidates)
	*  * Which shadow rules match often enough to be worth promoting?
	*
	* Writes are coalesced: rule matches arrive in bursts during page load, and
	* one storage write per match would be both slow and pointless.
	*/
	var KEY = "stats";
	var FLUSH_DELAY_MS = 4e3;
	var MAX_DAYS = 30;
	var MAX_SITES = 200;
	var MAX_TRACKED_RULES = 2e4;
	function emptyState() {
		return {
			totalBlocked: 0,
			since: Date.now(),
			daily: {},
			sites: {},
			ruleHits: {},
			shadow: {}
		};
	}
	var state = null;
	var flushTimer = null;
	var dirty = false;
	async function ensure() {
		if (state) return state;
		const stored = await chrome.storage.local.get(KEY);
		state = {
			...emptyState(),
			...stored[KEY]
		};
		return state;
	}
	function today() {
		return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
	}
	function scheduleFlush() {
		dirty = true;
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flush();
		}, FLUSH_DELAY_MS);
	}
	/** Write pending counters. Also called on worker suspend so nothing is lost. */
	async function flush() {
		if (!dirty || !state) return;
		dirty = false;
		prune(state);
		await chrome.storage.local.set({ [KEY]: state });
	}
	/**
	* Bound every unbounded map.
	*
	* ponytail: plain sort-and-truncate, O(n log n) on each flush. With a 200-site
	* and 30-day ceiling that is a few hundred entries, which is nothing next to the
	* storage write it precedes. Upgrade path: a min-heap, if the caps ever grow by
	* two orders of magnitude.
	*/
	function prune(s) {
		const days = Object.keys(s.daily).sort();
		for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete s.daily[day];
		const sites = Object.entries(s.sites);
		if (sites.length > MAX_SITES) {
			sites.sort((a, b) => b[1] - a[1]);
			s.sites = Object.fromEntries(sites.slice(0, MAX_SITES));
		}
		if (Object.keys(s.ruleHits).length > MAX_TRACKED_RULES) {
			const entries = Object.entries(s.ruleHits).sort((a, b) => b[1] - a[1]);
			s.ruleHits = Object.fromEntries(entries.slice(0, MAX_TRACKED_RULES));
		}
	}
	async function recordBlock(ruleId, host) {
		const s = await ensure();
		s.totalBlocked += 1;
		const day = today();
		(s.daily[day] ??= {
			blocked: 0,
			shadow: 0
		}).blocked += 1;
		if (host) s.sites[host] = (s.sites[host] ?? 0) + 1;
		s.ruleHits[ruleId] = (s.ruleHits[ruleId] ?? 0) + 1;
		scheduleFlush();
	}
	/**
	* Record a shadow-rule match.
	*
	* A shadow rule is a priority-1 `allow` that can never outrank a real block, so
	* this is a pure observation: the request went through exactly as it would have
	* with the rule absent.
	*/
	async function recordShadow(ruleId, host) {
		const s = await ensure();
		const day = today();
		(s.daily[day] ??= {
			blocked: 0,
			shadow: 0
		}).shadow += 1;
		const now = Date.now();
		const entry = s.shadow[ruleId] ??= {
			matches: 0,
			hosts: [],
			firstSeen: now,
			lastSeen: now
		};
		entry.matches += 1;
		entry.lastSeen = now;
		if (host && entry.hosts.length < 50 && !entry.hosts.includes(host)) entry.hosts.push(host);
		scheduleFlush();
	}
	async function snapshot(meta, limit = 25) {
		const s = await ensure();
		const daily = Object.entries(s.daily).sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({
			day,
			blocked: v.blocked,
			shadow: v.shadow
		}));
		const topSites = Object.entries(s.sites).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([host, blocked]) => ({
			host,
			blocked
		}));
		const coldRules = [];
		for (const [ruleId, info] of meta) {
			if (info.shadow) continue;
			if (!s.ruleHits[ruleId]) {
				coldRules.push({
					ruleId,
					raw: info.raw,
					list: info.list
				});
				if (coldRules.length >= limit) break;
			}
		}
		const shadow = Object.entries(s.shadow).map(([id, v]) => {
			const ruleId = Number(id);
			const info = meta.get(ruleId);
			return {
				ruleId,
				raw: info?.raw ?? `rule ${ruleId}`,
				list: info?.list ?? "unknown",
				matches: v.matches,
				distinctHosts: v.hosts.length,
				firstSeen: v.firstSeen,
				lastSeen: v.lastSeen,
				riskScore: info?.riskScore ?? 0,
				riskBand: info?.riskBand ?? "low"
			};
		}).sort((a, b) => b.matches - a.matches).slice(0, limit);
		return {
			totalBlocked: s.totalBlocked,
			daily,
			topSites,
			coldRules,
			shadow,
			since: s.since
		};
	}
	async function reset() {
		state = emptyState();
		dirty = true;
		await flush();
	}
	//#endregion
	//#region src/core/userfilters.ts
	/**
	* Custom user filters.
	*
	* Two things make this more than "append text to a list":
	*
	*  * Every line is parsed and scored before it is applied, so a typo is
	*    reported with a reason instead of silently doing nothing.
	*  * A line the risk model rates High or above is compiled into **shadow mode**
	*    until the user explicitly confirms it. It still matches, it still shows up
	*    in diagnostics, but it cannot change a single request until confirmed.
	*
	* That turns the most dangerous thing a user can do — hand-write a broad
	* blocking rule — into something observable first and enforced second.
	*/
	/**
	* Dynamic rule ids start here.
	*
	* Dynamic and static rules live in separate id namespaces, so this is not
	* required for correctness. It is required for *legibility*: a rule id above
	* this line in a diagnostics dump is unambiguously the user's own.
	*/
	var USER_RULE_ID_BASE = 1e6;
	/** Split filter text into the lines that may be enforced and those that may not. */
	function partition(text, validation, confirmed) {
		const enforced = [];
		const shadowed = [];
		for (const line of validation.lines) {
			if (line.kind === "comment" || line.kind === "error") continue;
			if (line.needsConfirmation && !confirmed.has(line.raw)) shadowed.push(line.raw);
			else enforced.push(line.raw);
		}
		return {
			enforced: enforced.join("\n"),
			shadowed: shadowed.join("\n")
		};
	}
	async function applyUserFilters(text, confirmedRiskyFilters) {
		const validation = await validateFilters(text);
		const { enforced, shadowed } = partition(text, validation, new Set(confirmedRiskyFilters));
		const rules = [];
		let unsupported = 0;
		if (enforced.trim()) {
			const compiled = await compileUserFilters(enforced, USER_RULE_ID_BASE, false);
			rules.push(...compiled.rules);
			unsupported += compiled.unsupported.length;
		}
		if (shadowed.trim()) {
			const compiled = await compileUserFilters(shadowed, 15e5, true);
			rules.push(...compiled.rules);
			unsupported += compiled.unsupported.length;
		}
		const existing = await chrome.declarativeNetRequest.getDynamicRules();
		await chrome.declarativeNetRequest.updateDynamicRules({
			removeRuleIds: existing.map((r) => r.id),
			addRules: rules
		});
		return {
			applied: rules.filter((r) => r.priority !== 1).length,
			shadowed: rules.filter((r) => r.priority === 1).length,
			unsupported,
			errors: validation.errors
		};
	}
	/** Remove every dynamic rule. Used when the master switch goes off. */
	async function clearUserFilters() {
		const existing = await chrome.declarativeNetRequest.getDynamicRules();
		if (existing.length === 0) return;
		await chrome.declarativeNetRequest.updateDynamicRules({
			removeRuleIds: existing.map((r) => r.id),
			addRules: []
		});
	}
	//#endregion
	//#region entrypoints/background.ts
	/**
	* The 404AD service worker: the control plane.
	*
	* It never sees a network request. Chromium's declarativeNetRequest engine
	* matches and blocks on its own, and reports back afterwards through
	* `onRuleMatchedDebug`. Everything here is configuration, observation and
	* answering questions from the UI.
	*/
	var background_default = defineBackground(() => {
		const hiddenByTab = /* @__PURE__ */ new Map();
		let shadowIds = /* @__PURE__ */ new Set();
		async function bootstrap() {
			await Promise.all([
				syncRulesets(),
				syncSessionRules(),
				initEngine().catch((e) => console.error("404AD: engine init failed", e))
			]);
			shadowIds = await shadowRuleIds().catch(() => /* @__PURE__ */ new Set());
			const settings = await loadSettings();
			if (settings.enabled && settings.userFilters.trim()) await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters).catch((e) => console.error("404AD: user filters failed to apply", e));
		}
		chrome.runtime.onInstalled.addListener((details) => {
			if (details.reason === "install") chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
			bootstrap();
		});
		chrome.runtime.onStartup.addListener(() => void bootstrap());
		bootstrap();
		chrome.runtime.onSuspend?.addListener(() => {
			flush();
		});
		const feedback = chrome.declarativeNetRequest.onRuleMatchedDebug;
		feedback?.addListener((info) => {
			const { request, rule } = info;
			const shadow = shadowIds.has(rule.ruleId);
			const host = hostOf(request.initiator ?? request.url);
			recordMatch(request.tabId, {
				ruleId: rule.ruleId,
				rulesetId: rule.rulesetId,
				url: request.url,
				type: request.type,
				timestamp: Date.now(),
				shadow
			});
			loadSettings().then((settings) => {
				if (!settings.statistics) return;
				return shadow ? recordShadow(rule.ruleId, host) : recordBlock(rule.ruleId, host);
			});
		});
		chrome.tabs.onRemoved.addListener((tabId) => {
			clearTab(tabId);
			hiddenByTab.delete(tabId);
		});
		chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
			if (changeInfo.status === "loading" && changeInfo.url !== void 0) {
				clearTab(tabId);
				hiddenByTab.delete(tabId);
			}
		});
		chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
			handle(message, sender).then((data) => sendResponse({
				ok: true,
				data
			})).catch((error) => sendResponse({
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			}));
			return true;
		});
		async function handle(message, sender) {
			switch (message.type) {
				case "document:resolve": {
					const settings = await loadSettings();
					const mode = await resolveMode(message.host);
					const off = !settings.enabled || mode === "off";
					const cosmeticEnabled = !off && settings.cosmeticFiltering && mode === "default";
					const scriptletsEnabled = !off && settings.scriptlets && mode === "default";
					if (!cosmeticEnabled && !scriptletsEnabled) return {
						specific: [],
						generic: [],
						styles: [],
						scriptlets: [],
						procedural: [],
						unhideIds: [],
						mode,
						cosmeticEnabled,
						scriptletsEnabled
					};
					const resolved = await resolveDocument(message.host, message.tokens);
					const keep = (items) => settings.shadowMode ? items.filter((i) => !i.shadow) : items.filter((i) => !i.shadow);
					return {
						...resolved,
						specific: cosmeticEnabled ? resolved.specific : [],
						generic: cosmeticEnabled ? resolved.generic : [],
						styles: cosmeticEnabled ? resolved.styles : [],
						procedural: cosmeticEnabled ? keep(resolved.procedural) : [],
						scriptlets: scriptletsEnabled ? keep(resolved.scriptlets) : [],
						mode,
						cosmeticEnabled,
						scriptletsEnabled
					};
				}
				case "document:generic": {
					const settings = await loadSettings();
					const mode = await resolveMode(message.host);
					if (!settings.enabled || !settings.cosmeticFiltering || mode !== "default") return { generic: [] };
					return { generic: await selectGeneric(message.tokens, message.unhideIds) };
				}
				case "content:hidden": {
					const tabId = sender.tab?.id;
					if (tabId !== void 0) hiddenByTab.set(tabId, (hiddenByTab.get(tabId) ?? 0) + message.count);
					return { ok: true };
				}
				case "tab:state": return await tabState(message.tabId ?? await activeTabId());
				case "site:set":
					await setSiteMode(message.host, message.mode);
					return { ok: true };
				case "site:list": return await loadSites();
				case "settings:get": return await loadSettings();
				case "settings:set": {
					const next = await saveSettings(message.patch);
					await syncRulesets();
					if (!next.enabled) await clearUserFilters();
					else if (next.userFilters.trim()) await applyUserFilters(next.userFilters, next.confirmedRiskyFilters);
					else await clearUserFilters();
					shadowIds = await shadowRuleIds().catch(() => shadowIds);
					return next;
				}
				case "stats:get": return await snapshot(await ruleMetaMap());
				case "stats:reset":
					await reset();
					return { ok: true };
				case "engine:status": {
					const [stats, settings, enabled] = await Promise.all([
						engineStats(),
						loadSettings(),
						chrome.declarativeNetRequest.getEnabledRulesets()
					]);
					const file = await loadDiagnostics().catch(() => null);
					return {
						ready: isReady(),
						buildId: stats?.buildId ?? "",
						error: engineError(),
						networkRules: file ? Object.keys(file.network).length : 0,
						cosmeticGeneric: stats?.genericSelectors ?? 0,
						cosmeticHosts: stats?.hosts ?? 0,
						scriptlets: stats?.scriptlets ?? 0,
						enabledRulesets: enabled,
						feedbackAvailable: feedback !== void 0
					};
				}
				case "diagnostics:recent": return recentMatches(message.tabId);
				case "diagnostics:explain": return await explain(message.url, message.initiator, message.resourceType);
				case "diagnostics:rule": return await ruleMeta(message.ruleId);
				case "filters:validate": return await validateFilters(message.text);
				case "filters:apply": {
					const settings = await saveSettings({
						userFilters: message.text,
						confirmedRiskyFilters: message.confirmed
					});
					return await applyUserFilters(settings.userFilters, settings.confirmedRiskyFilters);
				}
			}
		}
		async function tabState(tabId) {
			const settings = await loadSettings();
			let host = "";
			try {
				host = hostOf((await chrome.tabs.get(tabId)).url ?? "");
			} catch {
				host = "";
			}
			return {
				tabId,
				host,
				mode: host ? await resolveMode(host) : "default",
				blocked: tabBlockedCount(tabId),
				hidden: hiddenByTab.get(tabId) ?? 0,
				shadowMatches: tabShadowCount(tabId),
				enabled: settings.enabled
			};
		}
	});
	async function activeTabId() {
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true
		});
		return tab?.id ?? -1;
	}
	function hostOf(url) {
		try {
			return new URL(url).hostname;
		} catch {
			return "";
		}
	}
	globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
	//#endregion
	//#region \0virtual:wxt-background-entrypoint?/Users/michael.jr/Developer/404AD/packages/extension/entrypoints/background.ts
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => ([...args], void 0),
		log: (...args) => ([...args], void 0),
		warn: (...args) => ([...args], void 0),
		error: (...args) => ([...args], void 0)
	};
	var result;
	try {
		result = background_default.main();
		if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
	} catch (err) {
		logger.error("The background crashed on startup!");
		throw err;
	}
	//#endregion
	return result;
})();
