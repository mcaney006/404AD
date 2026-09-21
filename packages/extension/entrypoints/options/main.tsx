import { render } from "preact";
import { useEffect } from "preact/hooks";
import { signal, useSignal } from "@preact/signals";
import "../../src/ui/styles.css";
import { send } from "../../src/core/messaging";
import type { SiteMode, ValidationResult } from "../../src/core/protocol";
import {
  error,
  formatCount,
  patchSettings,
  refreshSettings,
  refreshSites,
  refreshStats,
  refreshStatus,
  settings,
  sites,
  stats,
  status,
} from "../../src/ui/state";

type TabId = "overview" | "lists" | "filters" | "sites" | "stats" | "shadow";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "lists", label: "Filter lists" },
  { id: "filters", label: "Custom filters" },
  { id: "sites", label: "Sites" },
  { id: "stats", label: "Statistics" },
  { id: "shadow", label: "Shadow mode" },
];

const active = signal<TabId>("overview");

function Toggle(props: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div class="row between">
      <div class="col" style="gap:2px">
        <span>{props.label}</span>
        {props.hint && <span class="muted">{props.hint}</span>}
      </div>
      <button aria-pressed={props.on} onClick={() => props.onChange(!props.on)}>
        {props.on ? "On" : "Off"}
      </button>
    </div>
  );
}

function Overview() {
  const st = status.value;
  const s = settings.value;
  if (!st || !s) return <div class="empty">Loading…</div>;

  return (
    <div class="col">
      <div class="card col">
        <h3>Engine</h3>
        <div class="row between">
          <span>Status</span>
          <span class={`badge ${st.ready ? "low" : "high"}`}>
            {st.ready ? "ready" : "unavailable"}
          </span>
        </div>
        {st.error && (
          <p class="muted mono" style="margin:0">
            {st.error}
          </p>
        )}
        <div class="row between">
          <span>Build</span>
          <code class="truncate" title={st.buildId}>
            {st.buildId || "—"}
          </code>
        </div>
        <div class="row between">
          <span>Network rules</span>
          <span class="mono">{formatCount(st.networkRules)}</span>
        </div>
        <div class="row between">
          <span>Generic cosmetic selectors</span>
          <span class="mono">{formatCount(st.cosmeticGeneric)}</span>
        </div>
        <div class="row between">
          <span>Sites with specific rules</span>
          <span class="mono">{formatCount(st.cosmeticHosts)}</span>
        </div>
        <div class="row between">
          <span>Scriptlets</span>
          <span class="mono">{formatCount(st.scriptlets)}</span>
        </div>
        <div class="row between">
          <span>Rule-match feedback</span>
          <span class={`badge ${st.feedbackAvailable ? "low" : "medium"}`}>
            {st.feedbackAvailable ? "available" : "unavailable"}
          </span>
        </div>
        {!st.feedbackAvailable && (
          <p class="muted" style="margin:0">
            Chromium only reports rule matches to unpacked or policy-installed extensions. Blocking
            works either way; statistics and shadow observations do not.
          </p>
        )}
      </div>

      <div class="card col">
        <h3>Behaviour</h3>
        <Toggle
          label="Enabled"
          hint="Master switch. Turning this off unloads every rule."
          on={s.enabled}
          onChange={(v) => void patchSettings({ enabled: v })}
        />
        <Toggle
          label="Cosmetic filtering"
          hint="Hide ad containers and placeholders left behind after a block."
          on={s.cosmeticFiltering}
          onChange={(v) => void patchSettings({ cosmeticFiltering: v })}
        />
        <Toggle
          label="Scriptlets and site adapters"
          hint="Includes the YouTube player adapter."
          on={s.scriptlets}
          onChange={(v) => void patchSettings({ scriptlets: v })}
        />
        <Toggle
          label="Local statistics"
          hint="Counters stored in this browser profile. 404AD sends nothing anywhere."
          on={s.statistics}
          onChange={(v) => void patchSettings({ statistics: v })}
        />
        <Toggle
          label="Shadow mode"
          hint="Observe candidate rules without letting them change any request."
          on={s.shadowMode}
          onChange={(v) => void patchSettings({ shadowMode: v })}
        />
      </div>

      <div class="card col">
        <h3>Privacy</h3>
        <p class="muted" style="margin:0">
          404AD has no account, no server and no telemetry. It makes no network requests of its own:
          filter lists are compiled into the package at build time, and the WASM runtime is loaded
          from the extension itself. Everything on this page is read from local storage.
        </p>
      </div>
    </div>
  );
}

function Lists() {
  const st = status.value;
  const s = settings.value;
  const available = useSignal<Array<{ id: string; enabled: boolean; path: string }>>([]);

  useEffect(() => {
    void fetch(chrome.runtime.getURL("generated/rulesets.json"))
      .then((r) => r.json())
      .then((v) => {
        available.value = v;
      })
      .catch(() => undefined);
  }, []);

  if (!s || !st) return <div class="empty">Loading…</div>;

  return (
    <div class="col">
      <div class="card col">
        <h3>Rulesets</h3>
        <p class="muted" style="margin:0">
          Each ruleset is a separate compiled file. Chromium enforces a ceiling of 30,000 enabled
          static rules and 50 enabled rulesets; the compiler checks both at build time.
        </p>
        {available.value.map((ruleset) => {
          const on = s.rulesets[ruleset.id] ?? ruleset.enabled;
          return (
            <Toggle
              key={ruleset.id}
              label={ruleset.id}
              hint={ruleset.path}
              on={on}
              onChange={(next) =>
                void patchSettings({ rulesets: { ...s.rulesets, [ruleset.id]: next } })
              }
            />
          );
        })}
      </div>
      <div class="card col">
        <h3>Currently enabled in Chromium</h3>
        <code>{st.enabledRulesets.join(", ") || "none"}</code>
      </div>
    </div>
  );
}

function CustomFilters() {
  const s = settings.value;
  const text = useSignal<string | null>(null);
  const result = useSignal<ValidationResult | null>(null);
  const busy = useSignal(false);
  const applied = useSignal<string | null>(null);

  useEffect(() => {
    if (s && text.value === null) text.value = s.userFilters;
  }, [s]);

  if (!s || text.value === null) return <div class="empty">Loading…</div>;
  const confirmed = new Set(s.confirmedRiskyFilters);

  const validate = async (): Promise<void> => {
    busy.value = true;
    try {
      result.value = await send({ type: "filters:validate", text: text.value ?? "" });
    } finally {
      busy.value = false;
    }
  };

  const apply = async (): Promise<void> => {
    busy.value = true;
    try {
      const outcome = await send({
        type: "filters:apply",
        text: text.value ?? "",
        confirmed: [...confirmed],
      });
      applied.value = `${outcome.applied} enforced, ${outcome.shadowed} held in shadow mode, ${outcome.unsupported} not expressible in MV3, ${outcome.errors} errors`;
      await refreshSettings();
    } finally {
      busy.value = false;
    }
  };

  const toggleConfirm = async (raw: string): Promise<void> => {
    const next = new Set(confirmed);
    if (next.has(raw)) next.delete(raw);
    else next.add(raw);
    await patchSettings({ confirmedRiskyFilters: [...next] });
  };

  return (
    <div class="col">
      <div class="card col">
        <h3>Your filters</h3>
        <p class="muted" style="margin:0">
          Adblock Plus syntax. Every line is parsed and scored before it is applied. A rule the risk
          model rates <span class="badge high">high</span> or above is compiled into shadow mode: it
          matches and appears in diagnostics, but cannot change a request until you confirm it.
        </p>
        <textarea
          rows={10}
          spellcheck={false}
          value={text.value}
          onInput={(e) => {
            text.value = (e.target as HTMLTextAreaElement).value;
          }}
          placeholder={"||tracker.example^$third-party\nexample.com##.promo-rail"}
        />
        <div class="row">
          <button disabled={busy.value} onClick={() => void validate()}>
            Check
          </button>
          <button disabled={busy.value} onClick={() => void apply()}>
            Apply
          </button>
          {applied.value && <span class="muted">{applied.value}</span>}
        </div>
      </div>

      {result.value && (
        <div class="card col">
          <h3>
            {result.value.networkRules} network · {result.value.cosmeticRules} cosmetic ·{" "}
            {result.value.errors} errors · {result.value.needsConfirmation} need confirmation
          </h3>
          <table>
            <thead>
              <tr>
                <th class="num">Line</th>
                <th>Filter</th>
                <th>Risk</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {result.value.lines
                .filter((l) => l.kind !== "comment")
                .map((line) => (
                  <tr key={line.line}>
                    <td class="num mono">{line.line}</td>
                    <td class="mono truncate" style="max-width:280px" title={line.raw}>
                      {line.raw}
                    </td>
                    <td>
                      {line.kind === "error" ? (
                        <span class="badge critical">error</span>
                      ) : (
                        <span class={`badge ${line.riskBand}`}>
                          {line.riskBand} {line.riskScore}
                        </span>
                      )}
                    </td>
                    <td class="muted">
                      {line.error ?? line.riskFactors.join(", ")}
                      {line.needsConfirmation && (
                        <>
                          {" "}
                          <button
                            aria-pressed={confirmed.has(line.raw)}
                            onClick={() => void toggleConfirm(line.raw)}
                          >
                            {confirmed.has(line.raw) ? "confirmed" : "confirm"}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Sites() {
  const list = sites.value;
  const host = useSignal("");
  const mode = useSignal<SiteMode>("off");

  const add = async (): Promise<void> => {
    const value = host.value.trim().toLowerCase();
    if (!value) return;
    await send({ type: "site:set", host: value, mode: mode.value });
    host.value = "";
    await refreshSites();
  };

  return (
    <div class="col">
      <div class="card col">
        <h3>Per-site rules</h3>
        <p class="muted" style="margin:0">
          The most specific rule wins, and a rule covers every subdomain of its host. Turning a site
          off installs an <code>allowAllRequests</code> rule above every other priority, so "off"
          means off even against an <code>$important</code> rule.
        </p>
        <div class="row">
          <input
            type="text"
            class="grow"
            placeholder="example.com"
            value={host.value}
            onInput={(e) => {
              host.value = (e.target as HTMLInputElement).value;
            }}
          />
          <div class="switch">
            {(["relaxed", "off"] as SiteMode[]).map((m) => (
              <button
                key={m}
                aria-pressed={mode.value === m}
                onClick={() => {
                  mode.value = m;
                }}
              >
                {m}
              </button>
            ))}
          </div>
          <button onClick={() => void add()}>Add</button>
        </div>
      </div>

      <div class="card">
        {list.length === 0 ? (
          <p class="empty" style="margin:0">
            No per-site rules. Every site uses the default level.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Host</th>
                <th>Mode</th>
                <th class="num">Changed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((site) => (
                <tr key={site.host}>
                  <td class="mono">{site.host}</td>
                  <td>
                    <span class={`badge ${site.mode === "off" ? "high" : "medium"}`}>
                      {site.mode}
                    </span>
                  </td>
                  <td class="num muted">{new Date(site.updatedAt).toLocaleDateString()}</td>
                  <td class="num">
                    <button
                      onClick={() =>
                        void send({ type: "site:set", host: site.host, mode: "default" }).then(
                          refreshSites,
                        )
                      }
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Statistics() {
  const data = stats.value;
  if (!data) return <div class="empty">Loading…</div>;
  const peak = Math.max(1, ...data.daily.map((d) => d.blocked));

  return (
    <div class="col">
      <div class="card row" style="justify-content:space-around">
        <div class="metric">
          <span class="value">{formatCount(data.totalBlocked)}</span>
          <span class="label">requests blocked</span>
        </div>
        <div class="metric">
          <span class="value">{data.topSites.length}</span>
          <span class="label">sites seen</span>
        </div>
        <div class="metric">
          <span class="value">{new Date(data.since).toLocaleDateString()}</span>
          <span class="label">counting since</span>
        </div>
      </div>

      <div class="card col">
        <h3>Daily</h3>
        {data.daily.length === 0 ? (
          <p class="muted" style="margin:0">
            Nothing recorded yet.
          </p>
        ) : (
          data.daily.slice(-14).map((day) => (
            <div key={day.day} class="col" style="gap:2px">
              <div class="row between">
                <span class="mono">{day.day}</span>
                <span class="mono">
                  {formatCount(day.blocked)}
                  {day.shadow > 0 && <span class="muted"> +{formatCount(day.shadow)} shadow</span>}
                </span>
              </div>
              <div class="bar">
                <span style={`width:${(day.blocked / peak) * 100}%`} />
              </div>
            </div>
          ))
        )}
      </div>

      <div class="card col">
        <h3>Busiest sites</h3>
        {data.topSites.length === 0 ? (
          <p class="muted" style="margin:0">
            Nothing recorded yet.
          </p>
        ) : (
          <table>
            <tbody>
              {data.topSites.map((site) => (
                <tr key={site.host}>
                  <td class="mono truncate">{site.host}</td>
                  <td class="num mono">{formatCount(site.blocked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="card col">
        <h3>Rules that have never matched</h3>
        <p class="muted" style="margin:0">
          Dead weight against the 30,000-rule budget, or simply aimed at sites you do not visit.
        </p>
        {data.coldRules.length === 0 ? (
          <p class="muted" style="margin:0">
            Every rule has matched at least once.
          </p>
        ) : (
          <table>
            <tbody>
              {data.coldRules.map((rule) => (
                <tr key={rule.ruleId}>
                  <td class="mono truncate" title={rule.raw}>
                    {rule.raw}
                  </td>
                  <td class="num muted">{rule.list}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="row">
        <button onClick={() => void send({ type: "stats:reset" }).then(refreshStats)}>
          Reset statistics
        </button>
      </div>
    </div>
  );
}

function Shadow() {
  const data = stats.value;
  if (!data) return <div class="empty">Loading…</div>;

  return (
    <div class="col">
      <div class="card col">
        <h3>How shadow mode works</h3>
        <p class="muted" style="margin:0">
          A shadow rule is compiled into Chromium as an <code>allow</code> at priority 1. Nothing
          ranks below priority 1, so it can never outrank a real block and can never change what
          happens to a request. It still matches, and every match is counted here. That makes it
          safe to measure a candidate rule against real traffic before promoting it.
        </p>
      </div>

      <div class="card col">
        <h3>Observations</h3>
        {data.shadow.length === 0 ? (
          <p class="muted" style="margin:0">
            No shadow rules have matched yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>List</th>
                <th class="num">Matches</th>
                <th class="num">Sites</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {data.shadow.map((obs) => (
                <tr key={obs.ruleId}>
                  <td class="mono truncate" style="max-width:320px" title={obs.raw}>
                    {obs.raw}
                  </td>
                  <td class="muted">{obs.list}</td>
                  <td class="num mono">{formatCount(obs.matches)}</td>
                  <td class="num mono">{obs.distinctHosts}</td>
                  <td>
                    <span class={`badge ${obs.riskBand}`}>{obs.riskBand}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="muted" style="margin:0">
          A rule matching often, across many sites, with a low risk score is a promotion candidate:
          move it out of <code>lists/404ad-candidates.txt</code> into a real list and recompile.
        </p>
      </div>
    </div>
  );
}

function App() {
  useEffect(() => {
    void refreshSettings();
    void refreshStatus();
    void refreshStats();
    void refreshSites();
  }, []);

  return (
    <div style="max-width:780px;margin:0 auto;padding:20px" class="col">
      <div class="row between">
        <h1>404AD</h1>
        <span class="muted">
          Privacy-first content blocking. No account, no cloud, no telemetry.
        </span>
      </div>

      {error.value && (
        <div class="card">
          <span class="badge critical">error</span> <span class="mono">{error.value}</span>
        </div>
      )}

      <div class="switch" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-pressed={active.value === t.id}
            onClick={() => {
              active.value = t.id;
              if (t.id === "stats" || t.id === "shadow") void refreshStats();
              if (t.id === "sites") void refreshSites();
              if (t.id === "overview" || t.id === "lists") void refreshStatus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active.value === "overview" && <Overview />}
      {active.value === "lists" && <Lists />}
      {active.value === "filters" && <CustomFilters />}
      {active.value === "sites" && <Sites />}
      {active.value === "stats" && <Statistics />}
      {active.value === "shadow" && <Shadow />}
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(<App />, root);
