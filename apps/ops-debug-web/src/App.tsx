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

type TenantRecord = {
  id: string;
  name: string;
  status: string;
  timezone: string;
  plan: string;
  created_at: string;
};

type AgentRecord = {
  id: string;
  tenant_id: string;
  name: string;
  status: string;
  language: string;
  llm_model: string;
  stt_provider: string;
  tts_provider: string;
  voice_id: string | null;
  created_at: string;
};

type AgentVersionRecord = {
  id: string;
  agent_id: string;
  version: number;
  system_prompt: string;
  temperature: NumericLike;
  published_at: string | null;
  created_at: string;
  tool_ids: string[];
};

const defaultTenant = "11111111-1111-1111-1111-111111111111";
const storageKey = "ops-debug-web.config.v1";

type PersistedConfig = {
  apiBaseUrl: string;
  bootstrapKey: string;
  tenantId: string;
  token: string;
  loginEmail: string;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [firstAdminName, setFirstAdminName] = useState("");
  const [firstAdminTenantName, setFirstAdminTenantName] = useState("My Company");
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
  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentVersions, setAgentVersions] = useState<AgentVersionRecord[]>([]);
  const [newTenantName, setNewTenantName] = useState("");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentLanguage, setNewAgentLanguage] = useState("es");
  const [newAgentLlmModel, setNewAgentLlmModel] = useState("gpt-4o-mini");
  const [newAgentSttProvider, setNewAgentSttProvider] = useState("deepgram");
  const [newAgentTtsProvider, setNewAgentTtsProvider] = useState("rime");
  const [newVersionPrompt, setNewVersionPrompt] = useState(
    "Eres un agente de voz profesional. Responde de forma clara y breve en espanol."
  );
  const [newVersionTemperature, setNewVersionTemperature] = useState("0.3");

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
      if (typeof parsed.loginEmail === "string") {
        setLoginEmail(parsed.loginEmail);
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
      loginEmail,
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
    loginEmail,
    tenantId,
    toDate,
    token,
    userTurn
  ]);

  const selectedCall = useMemo(
    () => calls.find((call) => call.id === selectedCallId) ?? null,
    [calls, selectedCallId]
  );

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const tenantOptions = useMemo(() => {
    const items = [...tenants];
    if (tenantId && !items.some((tenant) => tenant.id === tenantId)) {
      items.unshift({
        id: tenantId,
        name: `Current tenant (${tenantId.slice(0, 8)}...)`,
        status: "unknown",
        timezone: "UTC",
        plan: "unknown",
        created_at: new Date(0).toISOString()
      });
    }
    return items;
  }, [tenantId, tenants]);

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

  async function loginWithPassword(event: FormEvent) {
    event.preventDefault();

    const email = loginEmail.trim();
    if (!email || !loginPassword) {
      setStatus("Enter email and password");
      return;
    }

    setBusy(true);
    setStatus("Signing in...");

    try {
      const response = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          password: loginPassword,
          tenant_id: isUuid(tenantId) ? tenantId : undefined
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Login failed (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as {
        token: string;
        active_membership?: { tenant_id: string; role: string };
      };

      setToken(payload.token);
      setManualTokenInput(payload.token);
      if (payload.active_membership?.tenant_id) {
        setTenantId(payload.active_membership.tenant_id);
      }
      setLoginPassword("");
      setStatus("Signed in successfully");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function registerFirstAdmin(event: FormEvent) {
    event.preventDefault();

    const email = loginEmail.trim();
    const name = firstAdminName.trim();
    const password = loginPassword;
    const tenantName = firstAdminTenantName.trim();

    if (!email || !name || !password || !tenantName) {
      setStatus("Complete name, email, password, and tenant name");
      return;
    }

    setBusy(true);
    setStatus("Registering first admin...");

    try {
      const response = await fetch(`${apiBaseUrl}/auth/register-first-admin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          name,
          password,
          tenant_name: tenantName,
          timezone: "UTC",
          plan: "starter"
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`First admin setup failed (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as {
        token: string;
        membership?: { tenant_id: string };
      };

      setToken(payload.token);
      setManualTokenInput(payload.token);
      if (payload.membership?.tenant_id) {
        setTenantId(payload.membership.tenant_id);
      }
      setStatus("First admin ready. You are signed in.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not register first admin");
    } finally {
      setBusy(false);
    }
  }

  async function loadTenants() {
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }

    setBusy(true);
    setStatus("Loading tenants...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/tenants`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`Tenants request failed (${response.status})`);
      }

      const body = (await response.json()) as { items: TenantRecord[] };
      setTenants(body.items);

      if (!tenantId && body.items[0]) {
        setTenantId(body.items[0].id);
      }

      setStatus(`Loaded ${body.items.length} tenants`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load tenants");
    } finally {
      setBusy(false);
    }
  }

  async function createTenant(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }

    const name = newTenantName.trim();
    if (name.length < 2) {
      setStatus("Tenant name must have at least 2 chars");
      return;
    }

    setBusy(true);
    setStatus("Creating tenant...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/tenants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name, timezone: "UTC", plan: "starter" })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Create tenant failed (${response.status}): ${body}`);
      }

      const tenant = (await response.json()) as TenantRecord;
      setNewTenantName("");
      setTenantId(tenant.id);
      await loadTenants();
      setStatus(`Tenant created: ${tenant.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create tenant");
    } finally {
      setBusy(false);
    }
  }

  async function loadAgents(targetTenantId = tenantId) {
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }

    if (!targetTenantId) {
      setStatus("Select a tenant first");
      return;
    }

    setBusy(true);
    setStatus("Loading agents...");
    try {
      const params = new URLSearchParams({ tenant_id: targetTenantId, limit: "200" });
      const response = await fetch(`${apiBaseUrl}/internal/agents?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`Agents request failed (${response.status})`);
      }

      const body = (await response.json()) as { items: AgentRecord[] };
      setAgents(body.items);

      const keepSelected = body.items.some((agent) => agent.id === selectedAgentId);
      const nextAgentId = keepSelected ? selectedAgentId : body.items[0]?.id ?? "";
      setSelectedAgentId(nextAgentId);
      if (!nextAgentId) {
        setAgentVersions([]);
      }

      setStatus(`Loaded ${body.items.length} agents`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load agents");
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }
    if (!tenantId) {
      setStatus("Select a tenant first");
      return;
    }

    const name = newAgentName.trim();
    if (name.length < 2) {
      setStatus("Agent name must have at least 2 chars");
      return;
    }

    setBusy(true);
    setStatus("Creating agent...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          name,
          language: newAgentLanguage,
          llm_model: newAgentLlmModel,
          stt_provider: newAgentSttProvider,
          tts_provider: newAgentTtsProvider
        })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Create agent failed (${response.status}): ${body}`);
      }

      const agent = (await response.json()) as AgentRecord;
      setNewAgentName("");
      await loadAgents(tenantId);
      setSelectedAgentId(agent.id);
      setStatus(`Agent created: ${agent.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create agent");
    } finally {
      setBusy(false);
    }
  }

  async function loadAgentVersions(agentId: string) {
    if (!token || !agentId) {
      return;
    }

    setBusy(true);
    setStatus("Loading agent versions...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/agents/${agentId}/versions`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        throw new Error(`Agent versions request failed (${response.status})`);
      }

      const body = (await response.json()) as { items: AgentVersionRecord[] };
      setAgentVersions(body.items);
      setStatus(`Loaded ${body.items.length} versions`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load agent versions");
    } finally {
      setBusy(false);
    }
  }

  async function createAgentVersion(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }
    if (!selectedAgentId) {
      setStatus("Select an agent first");
      return;
    }

    const prompt = newVersionPrompt.trim();
    if (prompt.length < 10) {
      setStatus("System prompt must have at least 10 chars");
      return;
    }

    const temperature = Number(newVersionTemperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setStatus("Temperature must be between 0 and 2");
      return;
    }

    setBusy(true);
    setStatus("Creating agent version...");
    try {
      const response = await fetch(`${apiBaseUrl}/internal/agents/${selectedAgentId}/versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ system_prompt: prompt, temperature })
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Create version failed (${response.status}): ${body}`);
      }

      await loadAgentVersions(selectedAgentId);
      setStatus("Agent version created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create agent version");
    } finally {
      setBusy(false);
    }
  }

  async function publishAgentVersion(versionId: string) {
    if (!token) {
      setStatus("Issue or paste JWT first");
      return;
    }
    if (!selectedAgentId) {
      setStatus("Select an agent first");
      return;
    }

    setBusy(true);
    setStatus("Publishing version...");
    try {
      const response = await fetch(
        `${apiBaseUrl}/internal/agents/${selectedAgentId}/versions/${versionId}/publish`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Publish version failed (${response.status}): ${body}`);
      }

      await loadAgentVersions(selectedAgentId);
      setStatus("Version published");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not publish version");
    } finally {
      setBusy(false);
    }
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
    const trimmedAgentFilter = agentFilter.trim();
    if (trimmedAgentFilter && isUuid(trimmedAgentFilter)) {
      params.set("agent_id", trimmedAgentFilter);
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
        <div className="panel-title-row">
          <h2>Portal Sign-In</h2>
          <small>Production-friendly auth (no manual JWT required)</small>
        </div>

        <form className="row" onSubmit={loginWithPassword}>
          <label>
            Email
            <input value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label>
            Password
            <input
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              placeholder="your password"
            />
          </label>
          <button disabled={busy} type="submit">
            Sign In
          </button>
        </form>

        <form className="row first-admin-row" onSubmit={registerFirstAdmin}>
          <label>
            First admin name (one-time setup)
            <input value={firstAdminName} onChange={(e) => setFirstAdminName(e.target.value)} placeholder="Owner" />
          </label>
          <label>
            First tenant name
            <input
              value={firstAdminTenantName}
              onChange={(e) => setFirstAdminTenantName(e.target.value)}
              placeholder="My Company"
            />
          </label>
          <button disabled={busy} type="submit">
            Register First Admin
          </button>
        </form>
      </section>

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
            Tenant workspace
            <select
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setAgentFilter("");
                setSelectedAgentId("");
                setAgents([]);
                setAgentVersions([]);
              }}
            >
              {tenantOptions.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.name} ({tenant.id.slice(0, 8)}...)
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy || !token} onClick={() => void loadTenants()} type="button">
            Load Tenants
          </button>
          <button disabled={busy || !token} onClick={() => void loadAgents()} type="button">
            Load Agents
          </button>
          <button
            disabled={busy || !token || !selectedAgentId}
            onClick={() => void loadAgentVersions(selectedAgentId)}
            type="button"
          >
            Load Versions
          </button>
        </div>

        <div className="admin-grid">
          <form className="admin-box" onSubmit={createTenant}>
            <h2>Create Tenant</h2>
            <label>
              Tenant name
              <input
                value={newTenantName}
                onChange={(e) => setNewTenantName(e.target.value)}
                placeholder="Acme Dental"
              />
            </label>
            <button disabled={busy || !token} type="submit">
              Create Tenant
            </button>
          </form>

          <form className="admin-box" onSubmit={createAgent}>
            <h2>Create Agent</h2>
            <div className="row">
              <label>
                Name
                <input
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  placeholder="Recepcion Clinica"
                />
              </label>
              <label>
                Language
                <input value={newAgentLanguage} onChange={(e) => setNewAgentLanguage(e.target.value)} />
              </label>
              <label>
                LLM model
                <input value={newAgentLlmModel} onChange={(e) => setNewAgentLlmModel(e.target.value)} />
              </label>
              <label>
                STT provider
                <input value={newAgentSttProvider} onChange={(e) => setNewAgentSttProvider(e.target.value)} />
              </label>
              <label>
                TTS provider
                <input value={newAgentTtsProvider} onChange={(e) => setNewAgentTtsProvider(e.target.value)} />
              </label>
            </div>
            <button disabled={busy || !token || !tenantId} type="submit">
              Create Agent
            </button>
          </form>
        </div>

        <div className="split admin-split">
          <div>
            <div className="panel-title-row">
              <h2>Tenant Agents</h2>
              <small>{agents.length} loaded</small>
            </div>
            <ul className="calls-list">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <button
                    className={selectedAgentId === agent.id ? "active" : ""}
                    onClick={() => {
                      setSelectedAgentId(agent.id);
                      setAgentFilter(agent.id);
                      void loadAgentVersions(agent.id);
                    }}
                    type="button"
                  >
                    <div className="call-main">
                      <strong>{agent.name}</strong>
                      <span className="badge ended">{agent.status}</span>
                    </div>
                    <small>Agent ID: {agent.id}</small>
                    <small>LLM: {agent.llm_model}</small>
                    <small>
                      STT/TTS: {agent.stt_provider} / {agent.tts_provider}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="admin-box">
            <div className="panel-title-row">
              <h2>Agent Versions</h2>
              <small>{selectedAgent ? selectedAgent.name : "Select an agent"}</small>
            </div>

            {selectedAgent ? (
              <>
                <form className="row" onSubmit={createAgentVersion}>
                  <label>
                    System prompt
                    <input
                      value={newVersionPrompt}
                      onChange={(e) => setNewVersionPrompt(e.target.value)}
                      placeholder="Prompt para el agente"
                    />
                  </label>
                  <label>
                    Temperature
                    <input
                      value={newVersionTemperature}
                      onChange={(e) => setNewVersionTemperature(e.target.value)}
                      placeholder="0.3"
                    />
                  </label>
                  <button disabled={busy || !token} type="submit">
                    Create Version
                  </button>
                </form>

                <div className="versions-list">
                  {agentVersions.map((version) => (
                    <article key={version.id} className="version-card">
                      <div className="panel-title-row">
                        <strong>v{version.version}</strong>
                        {version.published_at ? (
                          <span className="badge active">published</span>
                        ) : (
                          <button
                            disabled={busy || !token}
                            onClick={() => void publishAgentVersion(version.id)}
                            type="button"
                          >
                            Publish
                          </button>
                        )}
                      </div>
                      <small>Created: {formatDateTime(version.created_at)}</small>
                      <small>Temperature: {asNumber(version.temperature).toFixed(2)}</small>
                      <small>Tools mapped: {version.tool_ids.length}</small>
                      <pre>{version.system_prompt}</pre>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p>Select an agent to create and publish versions.</p>
            )}
          </div>
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
