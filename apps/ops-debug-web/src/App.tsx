import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type NumericLike = number | string | null;

type CallRecord = {
  id: string;
  agent_id: string;
  twilio_call_sid: string;
  outcome: string | null;
  handoff_reason: string | null;
  legal_hold: boolean;
  started_at: string;
  ended_at: string | null;
};

type KpiRecord = {
  day: string;
  tenant_id: string;
  agent_id: string | null;
  calls: number;
  avg_duration_sec: NumericLike;
  resolution_rate: NumericLike;
  handoff_rate: NumericLike;
  total_cost_usd: NumericLike;
};

type CallEvent = {
  id: string;
  ts: string;
  type: string;
  payload_json: unknown;
  processing_attempts: number;
  processed_at: string | null;
  last_error: string | null;
};

const defaultTenant = "11111111-1111-1111-1111-111111111111";
const storageKey = "ops-debug-web.config.v1";

type PersistedConfig = {
  apiBaseUrl: string;
  bootstrapKey: string;
  tenantId: string;
  token: string;
  fromDate: string;
  toDate: string;
  agentFilter: string;
  connectorUrl: string;
  connectorToken: string;
  userTurn: string;
  autoRefreshSeconds: number;
};

function asNumber(value: NumericLike): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function formatDateTime(input: string | null): string {
  if (!input) {
    return "-";
  }
  return new Date(input).toLocaleString();
}

function formatDay(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return input;
  }
  return date.toLocaleDateString();
}

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    return "0s";
  }

  const mins = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);

  if (mins === 0) {
    return `${seconds}s`;
  }

  return `${mins}m ${seconds}s`;
}

function toLocalDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function buildIsoFromDate(date: string, endOfDay: boolean): string | null {
  if (!date) {
    return null;
  }

  const full = `${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`;
  const parsed = new Date(full);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function parseJwtClaims(token: string): { tenant_id?: string; role?: string } | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = atob(padded);
    const claims = JSON.parse(decoded) as { tenant_id?: string; role?: string };
    return claims;
  } catch {
    return null;
  }
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function App() {
  const hasLoadedConfig = useRef(false);
  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:4000");
  const [bootstrapKey, setBootstrapKey] = useState(
    "a10159516f8d5a7e2b493824a02376691c2dda52b6afe9c6"
  );
  const [tenantId, setTenantId] = useState(defaultTenant);
  const [token, setToken] = useState("");
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [fromDate, setFromDate] = useState(toLocalDate(7));
  const [toDate, setToDate] = useState(toLocalDate(0));
  const [agentFilter, setAgentFilter] = useState("");
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(0);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [kpis, setKpis] = useState<KpiRecord[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string>("");
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [connectorUrl, setConnectorUrl] = useState("http://localhost:4200");
  const [connectorToken, setConnectorToken] = useState(
    "a44fccf1a89e46dbff6879ff84dfc13b8e4b553a0e1f0b1d"
  );
  const [connectorMode, setConnectorMode] = useState("unknown");
  const [userTurn, setUserTurn] = useState("Hola, dame un resumen breve de esta llamada");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      hasLoadedConfig.current = true;
      return;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;

      if (typeof parsed.apiBaseUrl === "string") {
        setApiBaseUrl(parsed.apiBaseUrl);
      }
      if (typeof parsed.bootstrapKey === "string") {
        setBootstrapKey(parsed.bootstrapKey);
      }
      if (typeof parsed.tenantId === "string") {
        setTenantId(parsed.tenantId);
      }
      if (typeof parsed.token === "string") {
        setToken(parsed.token);
        setManualTokenInput(parsed.token);
      }
      if (typeof parsed.fromDate === "string") {
        setFromDate(parsed.fromDate);
      }
      if (typeof parsed.toDate === "string") {
        setToDate(parsed.toDate);
      }
      if (typeof parsed.agentFilter === "string") {
        setAgentFilter(parsed.agentFilter);
      }
      if (typeof parsed.connectorUrl === "string") {
        setConnectorUrl(parsed.connectorUrl);
      }
      if (typeof parsed.connectorToken === "string") {
        setConnectorToken(parsed.connectorToken);
      }
      if (typeof parsed.userTurn === "string") {
        setUserTurn(parsed.userTurn);
      }
      if (typeof parsed.autoRefreshSeconds === "number" && Number.isFinite(parsed.autoRefreshSeconds)) {
        setAutoRefreshSeconds(parsed.autoRefreshSeconds);
      }
    } catch {
      // ignore malformed localStorage
    } finally {
      hasLoadedConfig.current = true;
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedConfig.current) {
      return;
    }

    const payload: PersistedConfig = {
      apiBaseUrl,
      bootstrapKey,
      tenantId,
      token,
      fromDate,
      toDate,
      agentFilter,
      connectorUrl,
      connectorToken,
      userTurn,
      autoRefreshSeconds
    };

    localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [
    agentFilter,
    apiBaseUrl,
    autoRefreshSeconds,
    bootstrapKey,
    connectorToken,
    connectorUrl,
    fromDate,
    tenantId,
    toDate,
    token,
    userTurn
  ]);

  const selectedCall = useMemo(
    () => calls.find((call) => call.id === selectedCallId) ?? null,
    [calls, selectedCallId]
  );

  const totals = useMemo(() => {
    let totalCalls = 0;
    let weightedDuration = 0;
    let weightedResolution = 0;
    let weightedHandoff = 0;
    let totalCost = 0;

    for (const row of kpis) {
      const callsInRow = Math.max(0, Math.round(asNumber(row.calls)));
      totalCalls += callsInRow;
      weightedDuration += asNumber(row.avg_duration_sec) * callsInRow;
      weightedResolution += asNumber(row.resolution_rate) * callsInRow;
      weightedHandoff += asNumber(row.handoff_rate) * callsInRow;
      totalCost += asNumber(row.total_cost_usd);
    }

    const avgDurationSec = totalCalls > 0 ? weightedDuration / totalCalls : 0;
    const resolutionRate = totalCalls > 0 ? weightedResolution / totalCalls : 0;
    const handoffRate = totalCalls > 0 ? weightedHandoff / totalCalls : 0;
    const activeCalls = calls.filter((call) => !call.ended_at).length;

    return {
      totalCalls,
      avgDurationSec,
      resolutionRate,
      handoffRate,
      totalCost,
      activeCalls
    };
  }, [calls, kpis]);

  const usingLocalhostApi = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const appHost = window.location.hostname;
    const apiLooksLocal = apiBaseUrl.includes("localhost") || apiBaseUrl.includes("127.0.0.1");
    return appHost !== "localhost" && appHost !== "127.0.0.1" && apiLooksLocal;
  }, [apiBaseUrl]);

  function applyManualToken() {
    const trimmed = manualTokenInput.trim();
    if (!trimmed) {
      setStatus("Paste a JWT first");
      return;
    }

    setToken(trimmed);
    const claims = parseJwtClaims(trimmed);
    if (claims?.tenant_id) {
      setTenantId(claims.tenant_id);
      setStatus(`Manual JWT loaded (tenant ${claims.tenant_id})`);
      return;
    }

    setStatus("Manual JWT loaded");
  }

  function clearToken() {
    setToken("");
    setManualTokenInput("");
    setStatus("JWT cleared");
  }

  async function bootstrapToken(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Issuing token...");

    try {
      const response = await fetch(`${apiBaseUrl}/internal/dev/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dev-bootstrap-key": bootstrapKey
        },
        body: JSON.stringify({
          user_id: "ops-debug-user",
          tenant_id: tenantId,
          role: "internal_admin",
          is_internal: true,
          expires_in: "2h"
        })
      });

      if (!response.ok) {
        throw new Error(`Token request failed (${response.status})`);
      }

      const body = (await response.json()) as { token: string };
      setToken(body.token);
      setManualTokenInput(body.token);
      setStatus("Token ready");
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        setStatus("/internal/dev/token returned 404. In production use a manual JWT.");
      } else {
        setStatus(error instanceof Error ? error.message : "Token bootstrap failed");
      }
    } finally {
      setBusy(false);
    }
  }

  function buildClientQuery(): URLSearchParams {
    const params = new URLSearchParams();
    const fromIso = buildIsoFromDate(fromDate, false);
    const toIso = buildIsoFromDate(toDate, true);

    if (fromIso) {
      params.set("from", fromIso);
    }
    if (toIso) {
      params.set("to", toIso);
    }
    if (agentFilter.trim()) {
      params.set("agent_id", agentFilter.trim());
    }

    return params;
  }

  async function loadDashboard() {
    if (!token) {
      setStatus("Issue token first");
      return;
    }

    setBusy(true);
    setStatus("Loading KPI and calls...");

    try {
      const query = buildClientQuery().toString();
      const callsUrl = `${apiBaseUrl}/client/calls${query ? `?${query}` : ""}`;
      const kpisUrl = `${apiBaseUrl}/client/kpis${query ? `?${query}` : ""}`;

      const [callsRes, kpisRes] = await Promise.all([
        fetch(callsUrl, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(kpisUrl, { headers: { Authorization: `Bearer ${token}` } })
      ]);

      if (!callsRes.ok) {
        throw new Error(`Calls request failed (${callsRes.status})`);
      }
      if (!kpisRes.ok) {
        throw new Error(`KPI request failed (${kpisRes.status})`);
      }

      const callsBody = (await callsRes.json()) as { items: CallRecord[] };
      const kpiBody = (await kpisRes.json()) as { items: KpiRecord[] };

      setCalls(callsBody.items);
      setKpis(kpiBody.items);

      const keepSelection = callsBody.items.some((call) => call.id === selectedCallId);
      const nextCallId = keepSelection ? selectedCallId : callsBody.items[0]?.id ?? "";
      setSelectedCallId(nextCallId);
      if (!nextCallId) {
        setEvents([]);
      }

      setStatus(`Loaded ${callsBody.items.length} calls and ${kpiBody.items.length} KPI rows`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load dashboard");
    } finally {
      setBusy(false);
    }
  }

  async function loadEvents(callId: string) {
    if (!token || !callId) {
      return;
    }

    setBusy(true);
    setStatus("Loading call timeline...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/calls/${callId}/events`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`Timeline request failed (${response.status})`);
      }

      const body = (await response.json()) as { items: CallEvent[] };
      setEvents(body.items);
      setStatus(`Loaded ${body.items.length} events`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load events");
    } finally {
      setBusy(false);
    }
  }

  async function sendUserTurn() {
    if (!selectedCallId) {
      setStatus("Select a call first");
      return;
    }
    if (!userTurn.trim()) {
      setStatus("Write a user message first");
      return;
    }

    setBusy(true);
    setStatus("Sending user turn to connector...");

    try {
      const response = await fetch(`${connectorUrl}/runtime/sessions/${selectedCallId}/user-turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connectorToken}`
        },
        body: JSON.stringify({ text: userTurn })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Connector request failed (${response.status}): ${body}`);
      }

      await loadEvents(selectedCallId);
      setStatus("User turn processed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send user turn");
    } finally {
      setBusy(false);
    }
  }

  async function checkConnectorMode() {
    setBusy(true);
    setStatus("Checking connector AI mode...");
    try {
      const response = await fetch(`${connectorUrl}/runtime/ai-mode`, {
        headers: { Authorization: `Bearer ${connectorToken}` }
      });
      if (!response.ok) {
        throw new Error(`Connector mode failed (${response.status})`);
      }
      const body = (await response.json()) as { mode: string };
      setConnectorMode(body.mode);
      setStatus(`Connector mode: ${body.mode}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read connector mode");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!token || autoRefreshSeconds <= 0) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadDashboard();
      if (selectedCallId) {
        void loadEvents(selectedCallId);
      }
    }, autoRefreshSeconds * 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    agentFilter,
    apiBaseUrl,
    autoRefreshSeconds,
    fromDate,
    selectedCallId,
    toDate,
    token
  ]);

  return (
    <div className="layout">
      <header className="hero">
        <h1>Voice Ops Command Center</h1>
        <p>Track KPI health, inspect calls, and debug runtime timelines from one screen.</p>
      </header>

      <section className="card">
        <form onSubmit={bootstrapToken} className="row">
          <label>
            API Base URL
            <input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} />
          </label>
          <label>
            Dev Bootstrap Key
            <input value={bootstrapKey} onChange={(e) => setBootstrapKey(e.target.value)} />
          </label>
          <label>
            Tenant ID
            <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
          </label>
          <button disabled={busy} type="submit">
            Issue JWT
          </button>
        </form>

        {usingLocalhostApi ? (
          <p className="warning">
            You are on Railway but API Base URL points to localhost. Use your public control-plane URL.
          </p>
        ) : null}

        <div className="row token-row">
          <label>
            Manual JWT (for production environments)
            <input
              value={manualTokenInput}
              onChange={(e) => setManualTokenInput(e.target.value)}
              placeholder="paste bearer token"
            />
          </label>
          <button disabled={busy} onClick={applyManualToken} type="button">
            Use Manual JWT
          </button>
          <button disabled={busy || !token} onClick={clearToken} type="button">
            Clear JWT
          </button>
        </div>

        <div className="status-row">
          <span>
            Auth: <strong>{token ? "Ready" : "Missing token"}</strong>
          </span>
          <span>
            JWT: <code>{token ? `${token.slice(0, 28)}...` : "not issued"}</code>
          </span>
          <span>Status: {status}</span>
        </div>
      </section>

      <section className="card">
        <div className="row">
          <label>
            From
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <label>
            Agent ID (optional)
            <input
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              placeholder="uuid"
            />
          </label>
          <label>
            Auto refresh
            <select
              value={String(autoRefreshSeconds)}
              onChange={(e) => setAutoRefreshSeconds(Number(e.target.value))}
            >
              <option value="0">Off</option>
              <option value="10">Every 10s</option>
              <option value="30">Every 30s</option>
              <option value="60">Every 60s</option>
            </select>
          </label>
          <button disabled={busy || !token} onClick={() => void loadDashboard()} type="button">
            Refresh Dashboard
          </button>
        </div>
      </section>

      <section className="kpi-grid">
        <article className="kpi-card">
          <h2>Total Calls</h2>
          <strong>{totals.totalCalls}</strong>
          <small>Aggregated from daily_kpis rows</small>
        </article>
        <article className="kpi-card">
          <h2>Average Duration</h2>
          <strong>{formatSeconds(totals.avgDurationSec)}</strong>
          <small>Weighted by call volume</small>
        </article>
        <article className="kpi-card">
          <h2>Resolution Rate</h2>
          <strong>{totals.resolutionRate.toFixed(2)}%</strong>
          <small>Outcome = resolved</small>
        </article>
        <article className="kpi-card">
          <h2>Handoff Rate</h2>
          <strong>{totals.handoffRate.toFixed(2)}%</strong>
          <small>Outcome = handoff or reason present</small>
        </article>
        <article className="kpi-card">
          <h2>Total Cost</h2>
          <strong>{usdFormatter.format(totals.totalCost)}</strong>
          <small>Summed from daily_kpis.total_cost_usd</small>
        </article>
        <article className="kpi-card">
          <h2>Active Calls</h2>
          <strong>{totals.activeCalls}</strong>
          <small>Open calls in current list</small>
        </article>
      </section>

      <section className="card">
        <div className="row connector-row">
          <label>
            Connector URL
            <input value={connectorUrl} onChange={(e) => setConnectorUrl(e.target.value)} />
          </label>
          <label>
            Connector Token
            <input value={connectorToken} onChange={(e) => setConnectorToken(e.target.value)} />
          </label>
          <label>
            Simulated User Turn
            <input value={userTurn} onChange={(e) => setUserTurn(e.target.value)} />
          </label>
          <button disabled={busy || !selectedCallId} onClick={() => void sendUserTurn()} type="button">
            Send User Turn
          </button>
          <button disabled={busy} onClick={() => void checkConnectorMode()} type="button">
            Check AI Mode
          </button>
        </div>
        <div className="status-row compact">
          <span>
            Connector mode: <code>{connectorMode}</code>
          </span>
        </div>
      </section>

      <section className="card split">
        <div className="calls-panel">
          <div className="panel-title-row">
            <h2>Calls</h2>
            <small>{calls.length} loaded</small>
          </div>
          <ul className="calls-list">
            {calls.map((call) => {
              const isSelected = selectedCallId === call.id;
              const isActive = !call.ended_at;
              return (
                <li key={call.id}>
                  <button
                    className={isSelected ? "active" : ""}
                    onClick={() => {
                      setSelectedCallId(call.id);
                      void loadEvents(call.id);
                    }}
                    type="button"
                  >
                    <div className="call-main">
                      <strong>{call.twilio_call_sid}</strong>
                      <span className={isActive ? "badge active" : "badge ended"}>
                        {isActive ? "active" : "ended"}
                      </span>
                    </div>
                    <small>Agent: {call.agent_id}</small>
                    <small>Started: {formatDateTime(call.started_at)}</small>
                    <small>Outcome: {call.outcome ?? "-"}</small>
                    {call.handoff_reason ? <small>Handoff: {call.handoff_reason}</small> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="timeline-panel">
          <div className="panel-title-row">
            <h2>Timeline</h2>
            {selectedCall ? (
              <button disabled={busy} onClick={() => void loadEvents(selectedCall.id)} type="button">
                Refresh Timeline
              </button>
            ) : null}
          </div>

          {selectedCall ? (
            <>
              <div className="call-meta">
                <span>
                  <strong>Call ID:</strong> <code>{selectedCall.id}</code>
                </span>
                <span>
                  <strong>Started:</strong> {formatDateTime(selectedCall.started_at)}
                </span>
                <span>
                  <strong>Ended:</strong> {formatDateTime(selectedCall.ended_at)}
                </span>
              </div>

              <div className="timeline">
                {events.length === 0 ? (
                  <p>No events loaded yet. Select a call or refresh timeline.</p>
                ) : (
                  events.map((evt) => (
                    <article key={evt.id}>
                      <h3>{evt.type}</h3>
                      <small>
                        {formatDateTime(evt.ts)} | attempts={evt.processing_attempts} | processed=
                        {evt.processed_at ? "yes" : "no"}
                      </small>
                      {evt.last_error ? <small className="error">last_error={evt.last_error}</small> : null}
                      <pre>{JSON.stringify(evt.payload_json, null, 2)}</pre>
                    </article>
                  ))
                )}
              </div>
            </>
          ) : (
            <p>Select a call to inspect timeline events.</p>
          )}
        </div>
      </section>

      <section className="card">
        <div className="panel-title-row">
          <h2>KPI Rows</h2>
          <small>{kpis.length} loaded</small>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Agent</th>
                <th>Calls</th>
                <th>Avg Duration</th>
                <th>Resolution %</th>
                <th>Handoff %</th>
                <th>Cost USD</th>
              </tr>
            </thead>
            <tbody>
              {kpis.map((row) => (
                <tr key={`${row.day}-${row.agent_id ?? "all"}`}>
                  <td>{formatDay(row.day)}</td>
                  <td>{row.agent_id ?? "all_agents"}</td>
                  <td>{row.calls}</td>
                  <td>{formatSeconds(asNumber(row.avg_duration_sec))}</td>
                  <td>{asNumber(row.resolution_rate).toFixed(2)}%</td>
                  <td>{asNumber(row.handoff_rate).toFixed(2)}%</td>
                  <td>{usdFormatter.format(asNumber(row.total_cost_usd))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
