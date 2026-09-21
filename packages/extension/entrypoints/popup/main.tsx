import { render } from "preact";
import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import "../../src/ui/styles.css";
import { send } from "../../src/core/messaging";
import type { CosmeticHit, SiteMode } from "../../src/core/protocol";
import { TEMPORARY_DURATIONS } from "../../src/core/sites";
import {
  error,
  formatCount,
  matches,
  patchSettings,
  refreshMatches,
  refreshSettings,
  refreshTab,
  setMode,
  settings,
  tab,
} from "../../src/ui/state";

const MODES: Array<{ id: SiteMode; label: string; hint: string }> = [
  { id: "default", label: "Full", hint: "Network rules, cosmetic rules and scriptlets" },
  { id: "relaxed", label: "Relaxed", hint: "Network rules only. Use when a layout breaks." },
  { id: "off", label: "Off", hint: "Nothing is filtered on this site." },
];

function Diagnostics() {
  const open = useSignal(false);
  const cosmetic = useSignal<CosmeticHit[]>([]);
  const state = tab.value;

  useEffect(() => {
    if (!open.value || !state) return;
    void refreshMatches(state.tabId);
    void send({ type: "diagnostics:cosmetic", tabId: state.tabId })
      .then((hits) => {
        cosmetic.value = hits;
      })
      .catch(() => undefined);
  }, [open.value, state?.tabId]);

  if (!state) return null;
  const network = matches.value;

  return (
    <div class="card col">
      <button
        class="row between"
        style="background:none;border:0;padding:0;width:100%"
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <h3>Why was it blocked or hidden</h3>
        <span class="muted">{open.value ? "−" : "+"}</span>
      </button>

      {open.value && (
        <>
          <h3>Requests</h3>
          {network.length === 0 ? (
            <p class="muted" style="margin:0">
              No rule matches recorded for this tab. Reload the page, then reopen this panel.
            </p>
          ) : (
            <div class="col" style="gap:6px">
              {network.slice(0, 10).map((match) => (
                <div
                  key={`${match.ruleId}-${match.timestamp}-${match.url}`}
                  class="col"
                  style="gap:1px"
                >
                  <div class="row between">
                    <span class="mono truncate" style="max-width:220px" title={match.url}>
                      {match.url}
                    </span>
                    <span class="badge">{match.type}</span>
                  </div>
                  <div class="row" style="gap:6px">
                    <span class={`badge ${match.shadow ? "shadow" : "high"}`}>
                      {match.shadow ? "observed" : "blocked"}
                    </span>
                    <code class="truncate grow" title={match.raw ?? undefined}>
                      {match.raw ?? `rule #${match.ruleId}`}
                    </code>
                  </div>
                  <span class="muted">
                    {match.list ? `${match.list}:${match.line}` : match.rulesetId} · rule #
                    {match.ruleId}
                    {match.riskBand && ` · risk ${match.riskBand} ${match.riskScore}`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h3>Elements</h3>
          {cosmetic.value.length === 0 ? (
            <p class="muted" style="margin:0">
              Nothing hidden on this tab.
            </p>
          ) : (
            <table>
              <tbody>
                {cosmetic.value.slice(0, 10).map((hit) => (
                  <tr key={hit.selector}>
                    <td class="mono truncate" style="max-width:230px" title={hit.selector}>
                      {hit.selector}
                      {hit.procedural && <span class="badge"> procedural</span>}
                    </td>
                    <td class="num mono">{hit.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function App() {
  useEffect(() => {
    void refreshSettings();
    void refreshTab();
    const timer = setInterval(() => void refreshTab(), 1_000);
    return () => clearInterval(timer);
  }, []);

  const s = settings.value;
  const state = tab.value;

  if (error.value) {
    return (
      <div style="padding:14px" class="col">
        <h1>404AD</h1>
        <p class="muted">{error.value}</p>
      </div>
    );
  }
  if (!s || !state) {
    return <div class="empty">Loading…</div>;
  }

  const host = state.host || "this page";

  return (
    <div style="width:340px;padding:12px" class="col">
      <div class="row between">
        <h1>404AD</h1>
        <button
          aria-pressed={s.enabled}
          onClick={() => void patchSettings({ enabled: !s.enabled })}
          title={s.enabled ? "Turn 404AD off everywhere" : "Turn 404AD on"}
        >
          {s.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      <div class="card col">
        <div class="row between">
          <span class="truncate grow mono" title={state.host}>
            {host}
          </span>
        </div>
        <div class="switch" role="group" aria-label="Filtering level for this site">
          {MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={state.mode === m.id}
              title={m.hint}
              disabled={!state.host}
              onClick={() => void setMode(state.host, m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p class="muted" style="margin:0">
          {MODES.find((m) => m.id === state.mode)?.hint}
        </p>

        {state.mode !== "default" && (
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <span class="muted">Just for:</span>
            {TEMPORARY_DURATIONS.map((duration) => (
              <button
                key={duration.ms}
                disabled={!state.host}
                onClick={() => void setMode(state.host, state.mode, duration.ms)}
              >
                {duration.label}
              </button>
            ))}
            <span class="muted">
              {state.expiresAt
                ? `lapses ${new Date(state.expiresAt).toLocaleTimeString()}`
                : "permanent"}
            </span>
          </div>
        )}
      </div>

      <div class="card row" style="justify-content:space-around">
        <div class="metric">
          <span class="value">{formatCount(state.blocked)}</span>
          <span class="label">requests blocked</span>
        </div>
        <div class="metric">
          <span class="value">{formatCount(state.hidden)}</span>
          <span class="label">elements hidden</span>
        </div>
        <div class="metric">
          <span class="value">{formatCount(state.shadowMatches)}</span>
          <span class="label">shadow matches</span>
        </div>
      </div>

      <Diagnostics />

      <div class="row between">
        <span class="muted">Counters are local to this device.</span>
        <button
          onClick={() =>
            void send({ type: "settings:get" }).then(() => chrome.runtime.openOptionsPage())
          }
        >
          Settings
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(<App />, root);
