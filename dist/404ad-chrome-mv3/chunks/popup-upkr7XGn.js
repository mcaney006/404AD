import { C as S, S as R, _ as tab, a as patchSettings, d as refreshTab, f as setMode, i as matches, n as error, o as refreshMatches, p as settings, r as formatCount, s as refreshSettings, t as u, v as send, x as h, y as useSignal } from "./jsxRuntime.module-CxOplL_Z.js";
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
	const state = tab.value;
	h(() => {
		if (open.value && state) refreshMatches(state.tabId);
	}, [open.value, state?.tabId]);
	if (!state) return null;
	return /* @__PURE__ */ u("div", {
		class: "card col",
		children: [/* @__PURE__ */ u("button", {
			class: "row between",
			style: "background:none;border:0;padding:0;width:100%",
			onClick: () => {
				open.value = !open.value;
			},
			children: [/* @__PURE__ */ u("h3", { children: "Why was it blocked" }), /* @__PURE__ */ u("span", {
				class: "muted",
				children: open.value ? "−" : "+"
			})]
		}), open.value && (matches.value.length === 0 ? /* @__PURE__ */ u("p", {
			class: "muted",
			style: "margin:0",
			children: "No rule matches recorded for this tab yet. Reload the page with the popup closed, then reopen it."
		}) : /* @__PURE__ */ u("table", { children: [/* @__PURE__ */ u("thead", { children: /* @__PURE__ */ u("tr", { children: [/* @__PURE__ */ u("th", { children: "Request" }), /* @__PURE__ */ u("th", { children: "Rule" })] }) }), /* @__PURE__ */ u("tbody", { children: matches.value.slice(0, 12).map((m) => /* @__PURE__ */ u("tr", { children: [/* @__PURE__ */ u("td", {
			class: "truncate mono",
			style: "max-width:190px",
			title: m.url,
			children: m.url
		}), /* @__PURE__ */ u("td", {
			class: "mono",
			children: [
				"#",
				m.ruleId,
				m.shadow && /* @__PURE__ */ u(S, { children: [" ", /* @__PURE__ */ u("span", {
					class: "badge shadow",
					children: "shadow"
				})] })
			]
		})] }, `${m.ruleId}-${m.timestamp}-${m.url}`)) })] }))]
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
