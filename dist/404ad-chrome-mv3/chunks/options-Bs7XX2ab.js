import { C as S, S as R, a as patchSettings, b as y, c as refreshSites, g as status, h as stats, l as refreshStats, m as sites, n as error, p as settings, r as formatCount, s as refreshSettings, t as u, u as refreshStatus, v as send, x as h, y as useSignal } from "./jsxRuntime.module-CxOplL_Z.js";
//#region entrypoints/options/main.tsx
var TABS = [
	{
		id: "overview",
		label: "Overview"
	},
	{
		id: "lists",
		label: "Filter lists"
	},
	{
		id: "filters",
		label: "Custom filters"
	},
	{
		id: "sites",
		label: "Sites"
	},
	{
		id: "stats",
		label: "Statistics"
	},
	{
		id: "shadow",
		label: "Shadow mode"
	}
];
var active = y("overview");
function Toggle(props) {
	return /* @__PURE__ */ u("div", {
		class: "row between",
		children: [/* @__PURE__ */ u("div", {
			class: "col",
			style: "gap:2px",
			children: [/* @__PURE__ */ u("span", { children: props.label }), props.hint && /* @__PURE__ */ u("span", {
				class: "muted",
				children: props.hint
			})]
		}), /* @__PURE__ */ u("button", {
			"aria-pressed": props.on,
			onClick: () => props.onChange(!props.on),
			children: props.on ? "On" : "Off"
		})]
	});
}
function Overview() {
	const st = status.value;
	const s = settings.value;
	if (!st || !s) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [
					/* @__PURE__ */ u("h3", { children: "Engine" }),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Status" }), /* @__PURE__ */ u("span", {
							class: `badge ${st.ready ? "low" : "high"}`,
							children: st.ready ? "ready" : "unavailable"
						})]
					}),
					st.error && /* @__PURE__ */ u("p", {
						class: "muted mono",
						style: "margin:0",
						children: st.error
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Build" }), /* @__PURE__ */ u("code", {
							class: "truncate",
							title: st.buildId,
							children: st.buildId || "—"
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Network rules" }), /* @__PURE__ */ u("span", {
							class: "mono",
							children: formatCount(st.networkRules)
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Generic cosmetic selectors" }), /* @__PURE__ */ u("span", {
							class: "mono",
							children: formatCount(st.cosmeticGeneric)
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Sites with specific rules" }), /* @__PURE__ */ u("span", {
							class: "mono",
							children: formatCount(st.cosmeticHosts)
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Scriptlets" }), /* @__PURE__ */ u("span", {
							class: "mono",
							children: formatCount(st.scriptlets)
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", { children: "Rule-match feedback" }), /* @__PURE__ */ u("span", {
							class: `badge ${st.feedbackAvailable ? "low" : "medium"}`,
							children: st.feedbackAvailable ? "available" : "unavailable"
						})]
					}),
					!st.feedbackAvailable && /* @__PURE__ */ u("p", {
						class: "muted",
						style: "margin:0",
						children: "Chromium only reports rule matches to unpacked or policy-installed extensions. Blocking works either way; statistics and shadow observations do not."
					})
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [
					/* @__PURE__ */ u("h3", { children: "Behaviour" }),
					/* @__PURE__ */ u(Toggle, {
						label: "Enabled",
						hint: "Master switch. Turning this off unloads every rule.",
						on: s.enabled,
						onChange: (v) => void patchSettings({ enabled: v })
					}),
					/* @__PURE__ */ u(Toggle, {
						label: "Cosmetic filtering",
						hint: "Hide ad containers and placeholders left behind after a block.",
						on: s.cosmeticFiltering,
						onChange: (v) => void patchSettings({ cosmeticFiltering: v })
					}),
					/* @__PURE__ */ u(Toggle, {
						label: "Scriptlets and site adapters",
						hint: "Includes the YouTube player adapter.",
						on: s.scriptlets,
						onChange: (v) => void patchSettings({ scriptlets: v })
					}),
					/* @__PURE__ */ u(Toggle, {
						label: "Local statistics",
						hint: "Counters stored in this browser profile. 404AD sends nothing anywhere.",
						on: s.statistics,
						onChange: (v) => void patchSettings({ statistics: v })
					}),
					/* @__PURE__ */ u(Toggle, {
						label: "Shadow mode",
						hint: "Observe candidate rules without letting them change any request.",
						on: s.shadowMode,
						onChange: (v) => void patchSettings({ shadowMode: v })
					})
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [/* @__PURE__ */ u("h3", { children: "Privacy" }), /* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: "404AD has no account, no server and no telemetry. It makes no network requests of its own: filter lists are compiled into the package at build time, and the WASM runtime is loaded from the extension itself. Everything on this page is read from local storage."
				})]
			})
		]
	});
}
function Lists() {
	const st = status.value;
	const s = settings.value;
	const available = useSignal([]);
	h(() => {
		fetch(chrome.runtime.getURL("generated/rulesets.json")).then((r) => r.json()).then((v) => {
			available.value = v;
		}).catch(() => void 0);
	}, []);
	if (!s || !st) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [/* @__PURE__ */ u("div", {
			class: "card col",
			children: [
				/* @__PURE__ */ u("h3", { children: "Rulesets" }),
				/* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: "Each ruleset is a separate compiled file. Chromium enforces a ceiling of 30,000 enabled static rules and 50 enabled rulesets; the compiler checks both at build time."
				}),
				available.value.map((ruleset) => {
					const on = s.rulesets[ruleset.id] ?? ruleset.enabled;
					return /* @__PURE__ */ u(Toggle, {
						label: ruleset.id,
						hint: ruleset.path,
						on,
						onChange: (next) => void patchSettings({ rulesets: {
							...s.rulesets,
							[ruleset.id]: next
						} })
					}, ruleset.id);
				})
			]
		}), /* @__PURE__ */ u("div", {
			class: "card col",
			children: [/* @__PURE__ */ u("h3", { children: "Currently enabled in Chromium" }), /* @__PURE__ */ u("code", { children: st.enabledRulesets.join(", ") || "none" })]
		})]
	});
}
function CustomFilters() {
	const s = settings.value;
	const text = useSignal(null);
	const result = useSignal(null);
	const busy = useSignal(false);
	const applied = useSignal(null);
	h(() => {
		if (s && text.value === null) text.value = s.userFilters;
	}, [s]);
	if (!s || text.value === null) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	const confirmed = new Set(s.confirmedRiskyFilters);
	const validate = async () => {
		busy.value = true;
		try {
			result.value = await send({
				type: "filters:validate",
				text: text.value ?? ""
			});
		} finally {
			busy.value = false;
		}
	};
	const apply = async () => {
		busy.value = true;
		try {
			const outcome = await send({
				type: "filters:apply",
				text: text.value ?? "",
				confirmed: [...confirmed]
			});
			applied.value = `${outcome.applied} enforced, ${outcome.shadowed} held in shadow mode, ${outcome.unsupported} not expressible in MV3, ${outcome.errors} errors`;
			await refreshSettings();
		} finally {
			busy.value = false;
		}
	};
	const toggleConfirm = async (raw) => {
		const next = new Set(confirmed);
		if (next.has(raw)) next.delete(raw);
		else next.add(raw);
		await patchSettings({ confirmedRiskyFilters: [...next] });
	};
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [/* @__PURE__ */ u("div", {
			class: "card col",
			children: [
				/* @__PURE__ */ u("h3", { children: "Your filters" }),
				/* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: [
						"Adblock Plus syntax. Every line is parsed and scored before it is applied. A rule the risk model rates ",
						/* @__PURE__ */ u("span", {
							class: "badge high",
							children: "high"
						}),
						" or above is compiled into shadow mode: it matches and appears in diagnostics, but cannot change a request until you confirm it."
					]
				}),
				/* @__PURE__ */ u("textarea", {
					rows: 10,
					spellcheck: false,
					value: text.value,
					onInput: (e) => {
						text.value = e.target.value;
					},
					placeholder: "||tracker.example^$third-party\nexample.com##.promo-rail"
				}),
				/* @__PURE__ */ u("div", {
					class: "row",
					children: [
						/* @__PURE__ */ u("button", {
							disabled: busy.value,
							onClick: () => void validate(),
							children: "Check"
						}),
						/* @__PURE__ */ u("button", {
							disabled: busy.value,
							onClick: () => void apply(),
							children: "Apply"
						}),
						applied.value && /* @__PURE__ */ u("span", {
							class: "muted",
							children: applied.value
						})
					]
				})
			]
		}), result.value && /* @__PURE__ */ u("div", {
			class: "card col",
			children: [/* @__PURE__ */ u("h3", { children: [
				result.value.networkRules,
				" network · ",
				result.value.cosmeticRules,
				" cosmetic ·",
				" ",
				result.value.errors,
				" errors · ",
				result.value.needsConfirmation,
				" need confirmation"
			] }), /* @__PURE__ */ u("table", { children: [/* @__PURE__ */ u("thead", { children: /* @__PURE__ */ u("tr", { children: [
				/* @__PURE__ */ u("th", {
					class: "num",
					children: "Line"
				}),
				/* @__PURE__ */ u("th", { children: "Filter" }),
				/* @__PURE__ */ u("th", { children: "Risk" }),
				/* @__PURE__ */ u("th", { children: "Notes" })
			] }) }), /* @__PURE__ */ u("tbody", { children: result.value.lines.filter((l) => l.kind !== "comment").map((line) => /* @__PURE__ */ u("tr", { children: [
				/* @__PURE__ */ u("td", {
					class: "num mono",
					children: line.line
				}),
				/* @__PURE__ */ u("td", {
					class: "mono truncate",
					style: "max-width:280px",
					title: line.raw,
					children: line.raw
				}),
				/* @__PURE__ */ u("td", { children: line.kind === "error" ? /* @__PURE__ */ u("span", {
					class: "badge critical",
					children: "error"
				}) : /* @__PURE__ */ u("span", {
					class: `badge ${line.riskBand}`,
					children: [
						line.riskBand,
						" ",
						line.riskScore
					]
				}) }),
				/* @__PURE__ */ u("td", {
					class: "muted",
					children: [line.error ?? line.riskFactors.join(", "), line.needsConfirmation && /* @__PURE__ */ u(S, { children: [" ", /* @__PURE__ */ u("button", {
						"aria-pressed": confirmed.has(line.raw),
						onClick: () => void toggleConfirm(line.raw),
						children: confirmed.has(line.raw) ? "confirmed" : "confirm"
					})] })]
				})
			] }, line.line)) })] })]
		})]
	});
}
function Sites() {
	const list = sites.value;
	const host = useSignal("");
	const mode = useSignal("off");
	const add = async () => {
		const value = host.value.trim().toLowerCase();
		if (!value) return;
		await send({
			type: "site:set",
			host: value,
			mode: mode.value
		});
		host.value = "";
		await refreshSites();
	};
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [/* @__PURE__ */ u("div", {
			class: "card col",
			children: [
				/* @__PURE__ */ u("h3", { children: "Per-site rules" }),
				/* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: [
						"The most specific rule wins, and a rule covers every subdomain of its host. Turning a site off installs an ",
						/* @__PURE__ */ u("code", { children: "allowAllRequests" }),
						" rule above every other priority, so \"off\" means off even against an ",
						/* @__PURE__ */ u("code", { children: "$important" }),
						" rule."
					]
				}),
				/* @__PURE__ */ u("div", {
					class: "row",
					children: [
						/* @__PURE__ */ u("input", {
							type: "text",
							class: "grow",
							placeholder: "example.com",
							value: host.value,
							onInput: (e) => {
								host.value = e.target.value;
							}
						}),
						/* @__PURE__ */ u("div", {
							class: "switch",
							children: ["relaxed", "off"].map((m) => /* @__PURE__ */ u("button", {
								"aria-pressed": mode.value === m,
								onClick: () => {
									mode.value = m;
								},
								children: m
							}, m))
						}),
						/* @__PURE__ */ u("button", {
							onClick: () => void add(),
							children: "Add"
						})
					]
				})
			]
		}), /* @__PURE__ */ u("div", {
			class: "card",
			children: list.length === 0 ? /* @__PURE__ */ u("p", {
				class: "empty",
				style: "margin:0",
				children: "No per-site rules. Every site uses the default level."
			}) : /* @__PURE__ */ u("table", { children: [/* @__PURE__ */ u("thead", { children: /* @__PURE__ */ u("tr", { children: [
				/* @__PURE__ */ u("th", { children: "Host" }),
				/* @__PURE__ */ u("th", { children: "Mode" }),
				/* @__PURE__ */ u("th", {
					class: "num",
					children: "Changed"
				}),
				/* @__PURE__ */ u("th", {})
			] }) }), /* @__PURE__ */ u("tbody", { children: list.map((site) => /* @__PURE__ */ u("tr", { children: [
				/* @__PURE__ */ u("td", {
					class: "mono",
					children: site.host
				}),
				/* @__PURE__ */ u("td", { children: /* @__PURE__ */ u("span", {
					class: `badge ${site.mode === "off" ? "high" : "medium"}`,
					children: site.mode
				}) }),
				/* @__PURE__ */ u("td", {
					class: "num muted",
					children: new Date(site.updatedAt).toLocaleDateString()
				}),
				/* @__PURE__ */ u("td", {
					class: "num",
					children: /* @__PURE__ */ u("button", {
						onClick: () => void send({
							type: "site:set",
							host: site.host,
							mode: "default"
						}).then(refreshSites),
						children: "Remove"
					})
				})
			] }, site.host)) })] })
		})]
	});
}
function Statistics() {
	const data = stats.value;
	if (!data) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	const peak = Math.max(1, ...data.daily.map((d) => d.blocked));
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [
			/* @__PURE__ */ u("div", {
				class: "card row",
				style: "justify-content:space-around",
				children: [
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: formatCount(data.totalBlocked)
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "requests blocked"
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: data.topSites.length
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "sites seen"
						})]
					}),
					/* @__PURE__ */ u("div", {
						class: "metric",
						children: [/* @__PURE__ */ u("span", {
							class: "value",
							children: new Date(data.since).toLocaleDateString()
						}), /* @__PURE__ */ u("span", {
							class: "label",
							children: "counting since"
						})]
					})
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [/* @__PURE__ */ u("h3", { children: "Daily" }), data.daily.length === 0 ? /* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: "Nothing recorded yet."
				}) : data.daily.slice(-14).map((day) => /* @__PURE__ */ u("div", {
					class: "col",
					style: "gap:2px",
					children: [/* @__PURE__ */ u("div", {
						class: "row between",
						children: [/* @__PURE__ */ u("span", {
							class: "mono",
							children: day.day
						}), /* @__PURE__ */ u("span", {
							class: "mono",
							children: [formatCount(day.blocked), day.shadow > 0 && /* @__PURE__ */ u("span", {
								class: "muted",
								children: [
									" +",
									formatCount(day.shadow),
									" shadow"
								]
							})]
						})]
					}), /* @__PURE__ */ u("div", {
						class: "bar",
						children: /* @__PURE__ */ u("span", { style: `width:${day.blocked / peak * 100}%` })
					})]
				}, day.day))]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [/* @__PURE__ */ u("h3", { children: "Busiest sites" }), data.topSites.length === 0 ? /* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: "Nothing recorded yet."
				}) : /* @__PURE__ */ u("table", { children: /* @__PURE__ */ u("tbody", { children: data.topSites.map((site) => /* @__PURE__ */ u("tr", { children: [/* @__PURE__ */ u("td", {
					class: "mono truncate",
					children: site.host
				}), /* @__PURE__ */ u("td", {
					class: "num mono",
					children: formatCount(site.blocked)
				})] }, site.host)) }) })]
			}),
			/* @__PURE__ */ u("div", {
				class: "card col",
				children: [
					/* @__PURE__ */ u("h3", { children: "Rules that have never matched" }),
					/* @__PURE__ */ u("p", {
						class: "muted",
						style: "margin:0",
						children: "Dead weight against the 30,000-rule budget, or simply aimed at sites you do not visit."
					}),
					data.coldRules.length === 0 ? /* @__PURE__ */ u("p", {
						class: "muted",
						style: "margin:0",
						children: "Every rule has matched at least once."
					}) : /* @__PURE__ */ u("table", { children: /* @__PURE__ */ u("tbody", { children: data.coldRules.map((rule) => /* @__PURE__ */ u("tr", { children: [/* @__PURE__ */ u("td", {
						class: "mono truncate",
						title: rule.raw,
						children: rule.raw
					}), /* @__PURE__ */ u("td", {
						class: "num muted",
						children: rule.list
					})] }, rule.ruleId)) }) })
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "row",
				children: /* @__PURE__ */ u("button", {
					onClick: () => void send({ type: "stats:reset" }).then(refreshStats),
					children: "Reset statistics"
				})
			})
		]
	});
}
function Shadow() {
	const data = stats.value;
	if (!data) return /* @__PURE__ */ u("div", {
		class: "empty",
		children: "Loading…"
	});
	return /* @__PURE__ */ u("div", {
		class: "col",
		children: [/* @__PURE__ */ u("div", {
			class: "card col",
			children: [/* @__PURE__ */ u("h3", { children: "How shadow mode works" }), /* @__PURE__ */ u("p", {
				class: "muted",
				style: "margin:0",
				children: [
					"A shadow rule is compiled into Chromium as an ",
					/* @__PURE__ */ u("code", { children: "allow" }),
					" at priority 1. Nothing ranks below priority 1, so it can never outrank a real block and can never change what happens to a request. It still matches, and every match is counted here. That makes it safe to measure a candidate rule against real traffic before promoting it."
				]
			})]
		}), /* @__PURE__ */ u("div", {
			class: "card col",
			children: [
				/* @__PURE__ */ u("h3", { children: "Observations" }),
				data.shadow.length === 0 ? /* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: "No shadow rules have matched yet."
				}) : /* @__PURE__ */ u("table", { children: [/* @__PURE__ */ u("thead", { children: /* @__PURE__ */ u("tr", { children: [
					/* @__PURE__ */ u("th", { children: "Rule" }),
					/* @__PURE__ */ u("th", { children: "List" }),
					/* @__PURE__ */ u("th", {
						class: "num",
						children: "Matches"
					}),
					/* @__PURE__ */ u("th", {
						class: "num",
						children: "Sites"
					}),
					/* @__PURE__ */ u("th", { children: "Risk" })
				] }) }), /* @__PURE__ */ u("tbody", { children: data.shadow.map((obs) => /* @__PURE__ */ u("tr", { children: [
					/* @__PURE__ */ u("td", {
						class: "mono truncate",
						style: "max-width:320px",
						title: obs.raw,
						children: obs.raw
					}),
					/* @__PURE__ */ u("td", {
						class: "muted",
						children: obs.list
					}),
					/* @__PURE__ */ u("td", {
						class: "num mono",
						children: formatCount(obs.matches)
					}),
					/* @__PURE__ */ u("td", {
						class: "num mono",
						children: obs.distinctHosts
					}),
					/* @__PURE__ */ u("td", { children: /* @__PURE__ */ u("span", {
						class: `badge ${obs.riskBand}`,
						children: obs.riskBand
					}) })
				] }, obs.ruleId)) })] }),
				/* @__PURE__ */ u("p", {
					class: "muted",
					style: "margin:0",
					children: [
						"A rule matching often, across many sites, with a low risk score is a promotion candidate: move it out of ",
						/* @__PURE__ */ u("code", { children: "lists/404ad-candidates.txt" }),
						" into a real list and recompile."
					]
				})
			]
		})]
	});
}
function App() {
	h(() => {
		refreshSettings();
		refreshStatus();
		refreshStats();
		refreshSites();
	}, []);
	return /* @__PURE__ */ u("div", {
		style: "max-width:780px;margin:0 auto;padding:20px",
		class: "col",
		children: [
			/* @__PURE__ */ u("div", {
				class: "row between",
				children: [/* @__PURE__ */ u("h1", { children: "404AD" }), /* @__PURE__ */ u("span", {
					class: "muted",
					children: "Privacy-first content blocking. No account, no cloud, no telemetry."
				})]
			}),
			error.value && /* @__PURE__ */ u("div", {
				class: "card",
				children: [
					/* @__PURE__ */ u("span", {
						class: "badge critical",
						children: "error"
					}),
					" ",
					/* @__PURE__ */ u("span", {
						class: "mono",
						children: error.value
					})
				]
			}),
			/* @__PURE__ */ u("div", {
				class: "switch",
				role: "tablist",
				children: TABS.map((t) => /* @__PURE__ */ u("button", {
					role: "tab",
					"aria-pressed": active.value === t.id,
					onClick: () => {
						active.value = t.id;
						if (t.id === "stats" || t.id === "shadow") refreshStats();
						if (t.id === "sites") refreshSites();
						if (t.id === "overview" || t.id === "lists") refreshStatus();
					},
					children: t.label
				}, t.id))
			}),
			active.value === "overview" && /* @__PURE__ */ u(Overview, {}),
			active.value === "lists" && /* @__PURE__ */ u(Lists, {}),
			active.value === "filters" && /* @__PURE__ */ u(CustomFilters, {}),
			active.value === "sites" && /* @__PURE__ */ u(Sites, {}),
			active.value === "stats" && /* @__PURE__ */ u(Statistics, {}),
			active.value === "shadow" && /* @__PURE__ */ u(Shadow, {})
		]
	});
}
var root = document.getElementById("root");
if (root) R(/* @__PURE__ */ u(App, {}), root);
//#endregion
