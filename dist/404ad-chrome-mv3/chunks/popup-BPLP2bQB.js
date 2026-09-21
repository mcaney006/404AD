import { C as S, S as R, _ as tab, a as patchSettings, d as refreshTab, f as setMode, i as matches, n as error, o as refreshMatches, p as settings, r as formatCount, s as refreshSettings, t as u, v as send, x as h, y as useSignal } from "./jsxRuntime.module-CklenpV1.js";
//#region src/core/sites.ts
var KEY = "sites";
/** Durations the popup offers for a temporary exception. */
var TEMPORARY_DURATIONS = [
	{
		label: "10 minutes",
		ms: 6e5
	},
	{
		label: "1 hour",
		ms: 36e5
	},
	{
		label: "1 day",
		ms: 864e5
	}
];
/**
* Invalidate the cache when another extension context writes.
*
* Guarded so the module stays importable outside an extension realm, which is
* how `hostSuffixes` and `resolveMode` are unit tested.
*/
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && KEY in changes);
});
//#endregion
//#region entrypoints/popup/main.tsx
var MODES = [
	{
		id: "default",
		label: "Full",
		hint: "Network rules, cosmetic rules and scriptlets"
	},
	{
		id: "relaxed",
		label: "Relaxed",
		hint: "Network rules only. Use when a layout breaks."
	},
	{
		id: "off",
		label: "Off",
		hint: "Nothing is filtered on this site."
	}
];
function Diagnostics() {
	const open = useSignal(false);
	const cosmetic = useSignal([]);
	const state = tab.value;
	h(() => {
		if (!open.value || !state) return;
		refreshMatches(state.tabId);
		send({
			type: "diagnostics:cosmetic",
			tabId: state.tabId
		}).then((hits) => {
			cosmetic.value = hits;
		}).catch(() => void 0);
	}, [open.value, state?.tabId]);
	if (!state) return null;
	const network = matches.value;
	return /* @__PURE__ */ u("div", {
		class: "card col",
		children: [/* @__PURE__ */ u("button", {
			class: "row between",
			style: "background:none;border:0;padding:0;width:100%",
			onClick: () => {
				open.value = !open.value;
			},
			children: [/* @__PURE__ */ u("h3", { children: "Why was it blocked or hidden" }), /* @__PURE__ */ u("span", {
				class: "muted",
				children: open.value ? "−" : "+"
			})]
		}), open.value && /* @__PURE__ */ u(S, { children: [
			/* @__PURE__ */ u("h3", { children: "Requests" }),
			network.length === 0 ? /* @__PURE__ */ u("p", {
				class: "muted",
				style: "margin:0",
				children: "No rule matches recorded for this tab. Reload the page, then reopen this panel."
			}) : /* @__PURE__ */ u("div", {
				class: "col",
				style: "gap:6px",
				children: network.slice(0, 10).map((match) => /* @__PURE__ */ u("div", {
					class: "col",
					style: "gap:1px",
					children: [
						/* @__PURE__ */ u("div", {
							class: "row between",
							children: [/* @__PURE__ */ u("span", {
								class: "mono truncate",
								style: "max-width:220px",
								title: match.url,
								children: match.url
							}), /* @__PURE__ */ u("span", {
								class: "badge",
								children: match.type
							})]
						}),
						/* @__PURE__ */ u("div", {
							class: "row",
							style: "gap:6px",
							children: [/* @__PURE__ */ u("span", {
								class: `badge ${match.shadow ? "shadow" : "high"}`,
								children: match.shadow ? "observed" : "blocked"
							}), /* @__PURE__ */ u("code", {
								class: "truncate grow",
								title: match.raw ?? void 0,
								children: match.raw ?? `rule #${match.ruleId}`
							})]
						}),
						/* @__PURE__ */ u("span", {
							class: "muted",
							children: [
								match.list ? `${match.list}:${match.line}` : match.rulesetId,
								" · rule #",
								match.ruleId,
								match.riskBand && ` · risk ${match.riskBand} ${match.riskScore}`
							]
						})
					]
				}, `${match.ruleId}-${match.timestamp}-${match.url}`))
			}),
			/* @__PURE__ */ u("h3", { children: "Elements" }),
			cosmetic.value.length === 0 ? /* @__PURE__ */ u("p", {
				class: "muted",
				style: "margin:0",
				children: "Nothing hidden on this tab."
			}) : /* @__PURE__ */ u("table", { children: /* @__PURE__ */ u("tbody", { children: cosmetic.value.slice(0, 10).map((hit) => /* @__PURE__ */ u("tr", { children: [/* @__PURE__ */ u("td", {
				class: "mono truncate",
				style: "max-width:230px",
				title: hit.selector,
				children: [hit.selector, hit.procedural && /* @__PURE__ */ u("span", {
					class: "badge",
					children: " procedural"
				})]
			}), /* @__PURE__ */ u("td", {
				class: "num mono",
				children: hit.count
			})] }, hit.selector)) }) })
		] })]
	});
}
function App() {
	h(() => {
		refreshSettings();
		refreshTab();
		const timer = setInterval(() => void refreshTab(), 1e3);
		return () => clearInterval(timer);
	}, []);
	const s = settings.value;
	const state = tab.value;
	if (error.value) return /* @__PURE__ */ u("div", {
		style: "padding:14px",
		class: "col",
		children: [/* @__PURE__ */ u("h1", { children: "404AD" }), /* @__PURE__ */ u("p", {
			class: "muted",
			children: error.value
		})]
	});
	if (!s || !state) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	const host = state.host || "this page";
	return /* @__PURE__ */ u("div", {
		style: "width:340px;padding:12px",
		class: "col",
		children: [
			/* @__PURE__ */ u("div", {
				class: "row between",
				children: [/* @__PURE__ */ u("h1", { children: "404AD" }), /* @__PURE__ */ u("button", {
					"aria-pressed": s.enabled,
					onClick: () => void patchSettings({ enabled: !s.enabled }),
					title: s.enabled ? "Turn 404AD off everywhere" : "Turn 404AD on",
					children: s.enabled ? "Enabled" : "Disabled"
				})]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: /* @__PURE__ */ u("span", {
							class: "truncate grow mono",
							title: state.host,
							children: host
						})
					}),
					/* @__PURE__ */ u("div", {
						class: "switch",
						role: "group",
						"aria-label": "Filtering level for this site",
						children: MODES.map((m) => /* @__PURE__ */ u("button", {
							"aria-pressed": state.mode === m.id,
							title: m.hint,
							disabled: !state.host,
							onClick: () => void setMode(state.host, m.id),
							children: m.label
						}, m.id))
					}),
					/* @__PURE__ */ u("p", {
						class: "muted",
						style: "margin:0",
						children: MODES.find((m) => m.id === state.mode)?.hint
					}),
					state.mode !== "default" && /* @__PURE__ */ u("div", {
						class: "row",
						style: "gap:6px;flex-wrap:wrap",
						children: [
							/* @__PURE__ */ u("span", {
								class: "muted",
								children: "Just for:"
							}),
							TEMPORARY_DURATIONS.map((duration) => /* @__PURE__ */ u("button", {
								disabled: !state.host,
								onClick: () => void setMode(state.host, state.mode, duration.ms),
								children: duration.label
							}, duration.ms)),
							/* @__PURE__ */ u("span", {
								class: "muted",
								children: state.expiresAt ? `lapses ${new Date(state.expiresAt).toLocaleTimeString()}` : "permanent"
							})
						]
					})
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "card row",
				style: "justify-content:space-around",
				children: [
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: formatCount(state.blocked)
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "requests blocked"
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: formatCount(state.hidden)
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "elements hidden"
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: formatCount(state.shadowMatches)
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "shadow matches"
						})]
					})
				]
			}),
			/* @__PURE__ */ u(Diagnostics, {}),
			/* @__PURE__ */ u("div", {
				class: "row between",
				children: [/* @__PURE__ */ u("span", {
					class: "muted",
					children: "Counters are local to this device."
				}), /* @__PURE__ */ u("button", {
					onClick: () => void send({ type: "settings:get" }).then(() => chrome.runtime.openOptionsPage()),
					children: "Settings"
				})]
			})
		]
	});
}
var root = document.getElementById("root");
if (root) R(/* @__PURE__ */ u(App, {}), root);
//#endregion
