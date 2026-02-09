import { FormEvent, useMemo, useState } from "react";

type CallRecord = {
  id: string;
  tenant_id: string;
  agent_id: string;
  twilio_call_sid: string;
  outcome: string | null;
  handoff_reason: string | null;
  legal_hold: boolean;
  started_at: string;
  ended_at: string | null;
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

export function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:4000");
  const [bootstrapKey, setBootstrapKey] = useState(
    "a10159516f8d5a7e2b493824a02376691c2dda52b6afe9c6"
  );
  const [tenantId, setTenantId] = useState(defaultTenant);
  const [token, setToken] = useState("");
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string>("");
  const [events, setEvents] = useState<CallEvent[]>([]);
  const [connectorUrl, setConnectorUrl] = useState("http://localhost:4200");
  const [connectorToken, setConnectorToken] = useState(
    "a44fccf1a89e46dbff6879ff84dfc13b8e4b553a0e1f0b1d"
  );
  const [connectorMode, setConnectorMode] = useState("unknown");
  const [userTurn, setUserTurn] = useState("Hola, quiero pedir una pizza grande de pepperoni");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");

  const selectedCall = useMemo(
    () => calls.find((call) => call.id === selectedCallId) ?? null,
    [calls, selectedCallId]
  );

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
      setStatus("Token ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Token bootstrap failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadCalls() {
    if (!token) {
      setStatus("Create token first");
      return;
    }

    setBusy(true);
    setStatus("Loading calls...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/calls?limit=200`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) {
        throw new Error(`Calls request failed (${response.status})`);
      }

      const body = (await response.json()) as { items: CallRecord[] };
      setCalls(body.items);
      setSelectedCallId(body.items[0]?.id ?? "");
      setStatus(`Loaded ${body.items.length} calls`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load calls");
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

  return (
    <div className="layout">
      <header>
        <h1>Voice Ops Debug UI</h1>
        <p>Bootstrap JWT, inspect calls, and inspect runtime event timelines.</p>
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
            Issue Token
          </button>
        </form>

        <div className="token-box">
          <strong>JWT:</strong>
          <code>{token ? `${token.slice(0, 28)}...` : "not issued"}</code>
        </div>
      </section>

      <section className="card">
        <div className="row">
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
          <button disabled={busy || !selectedCallId} onClick={() => void sendUserTurn()}>
            Send User Turn
          </button>
          <button disabled={busy} onClick={() => void checkConnectorMode()}>
            Check AI Mode
          </button>
        </div>
        <div className="token-box">
          <strong>Connector AI Mode:</strong>
          <code>{connectorMode}</code>
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <button disabled={busy || !token} onClick={loadCalls}>
            Load Calls
          </button>
          <span>Status: {status}</span>
        </div>

        <div className="split">
          <div>
            <h2>Calls</h2>
            <ul className="list">
              {calls.map((call) => (
                <li key={call.id}>
                  <button
                    className={selectedCallId === call.id ? "active" : ""}
                    onClick={() => {
                      setSelectedCallId(call.id);
                      void loadEvents(call.id);
                    }}
                  >
                    <div>{call.twilio_call_sid}</div>
                    <small>{call.tenant_id}</small>
                    <small>{new Date(call.started_at).toLocaleString()}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2>Timeline</h2>
            {selectedCall ? (
              <div className="timeline">
                {events.map((evt) => (
                  <article key={evt.id}>
                    <h3>{evt.type}</h3>
                    <small>{new Date(evt.ts).toLocaleString()}</small>
                    <pre>{JSON.stringify(evt.payload_json, null, 2)}</pre>
                  </article>
                ))}
              </div>
            ) : (
              <p>Select a call to load events.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
