import { FormEvent, useEffect, useMemo, useState } from "react";

type NumericLike = number | string | null;
type ViewKey = "workspace" | "agents" | "operations";

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
  firstAdminTenantName: string;
  activeView: ViewKey;
};

const storageKey = "ops-debug-web.config.v3";
const defaultTenant = "11111111-1111-1111-1111-111111111111";

const defaultConfig: PersistedConfig = {
  apiBaseUrl: "http://localhost:4000",
  bootstrapKey: "",
  tenantId: defaultTenant,
  token: "",
  loginEmail: "",
  fromDate: toLocalDate(7),
  toDate: toLocalDate(0),
  agentFilter: "",
  connectorUrl: "http://localhost:4200",
  connectorToken: "",
  userTurn: "Hola, dame un resumen breve de esta llamada",
  autoRefreshSeconds: 0,
  firstAdminTenantName: "My Company",
  activeView: "workspace"
};

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

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
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return input;
  }
  return parsed.toLocaleDateString();
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

function parseJwtClaims(token: string): { tenant_id?: string; role?: string; sub?: string } | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = atob(padded);
    return JSON.parse(decoded) as { tenant_id?: string; role?: string; sub?: string };
  } catch {
    return null;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    const details = body ? `: ${body}` : "";
    throw new Error(`${response.status} ${response.statusText}${details}`);
  }

  return (await response.json()) as T;
}

export function App() {
  const [activeView, setActiveView] = useState<ViewKey>(defaultConfig.activeView);
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultConfig.apiBaseUrl);
  const [bootstrapKey, setBootstrapKey] = useState(defaultConfig.bootstrapKey);
  const [tenantId, setTenantId] = useState(defaultConfig.tenantId);
  const [token, setToken] = useState(defaultConfig.token);
  const [manualTokenInput, setManualTokenInput] = useState("");
  const [loginEmail, setLoginEmail] = useState(defaultConfig.loginEmail);
  const [loginPassword, setLoginPassword] = useState("");
  const [firstAdminName, setFirstAdminName] = useState("");
  const [firstAdminTenantName, setFirstAdminTenantName] = useState(defaultConfig.firstAdminTenantName);
  const [fromDate, setFromDate] = useState(defaultConfig.fromDate);
  const [toDate, setToDate] = useState(defaultConfig.toDate);
  const [agentFilter, setAgentFilter] = useState(defaultConfig.agentFilter);
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(defaultConfig.autoRefreshSeconds);

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [kpis, setKpis] = useState<KpiRecord[]>([]);
  const [selectedCallId, setSelectedCallId] = useState("");
  const [events, setEvents] = useState<CallEvent[]>([]);

  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [newTenantName, setNewTenantName] = useState("");

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentLanguage, setNewAgentLanguage] = useState("es");
  const [newAgentLlmModel, setNewAgentLlmModel] = useState("gpt-4o-mini");
  const [newAgentSttProvider, setNewAgentSttProvider] = useState("deepgram");
  const [newAgentTtsProvider, setNewAgentTtsProvider] = useState("rime");

  const [agentVersions, setAgentVersions] = useState<AgentVersionRecord[]>([]);
  const [newVersionPrompt, setNewVersionPrompt] = useState(
    "Eres un agente de voz profesional. Responde de forma clara y breve en espanol."
  );
  const [newVersionTemperature, setNewVersionTemperature] = useState("0.3");

  const [connectorUrl, setConnectorUrl] = useState(defaultConfig.connectorUrl);
  const [connectorToken, setConnectorToken] = useState(defaultConfig.connectorToken);
  const [connectorMode, setConnectorMode] = useState("unknown");
  const [userTurn, setUserTurn] = useState(defaultConfig.userTurn);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");

  const tokenClaims = useMemo(() => parseJwtClaims(token), [token]);

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

  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
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
      if (typeof parsed.autoRefreshSeconds === "number") {
        setAutoRefreshSeconds(parsed.autoRefreshSeconds);
      }
      if (typeof parsed.firstAdminTenantName === "string") {
        setFirstAdminTenantName(parsed.firstAdminTenantName);
      }
      if (parsed.activeView === "workspace" || parsed.activeView === "agents" || parsed.activeView === "operations") {
        setActiveView(parsed.activeView);
      }
    } catch {
      // ignore malformed localStorage
    }
  }, []);

  useEffect(() => {
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
      autoRefreshSeconds,
      firstAdminTenantName,
      activeView
    };

    localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [
    activeView,
    agentFilter,
    apiBaseUrl,
    autoRefreshSeconds,
    bootstrapKey,
    connectorToken,
    connectorUrl,
    firstAdminTenantName,
    fromDate,
    loginEmail,
    tenantId,
    toDate,
    token,
    userTurn
  ]);

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

  async function registerFirstAdmin(event: FormEvent) {
    event.preventDefault();

    const email = loginEmail.trim();
    const password = loginPassword;
    const name = firstAdminName.trim();
    const tenantName = firstAdminTenantName.trim();

    if (!email || !password || !name || !tenantName) {
      setStatus("Complete name, email, password and tenant name");
      return;
    }

    setBusy(true);
    setStatus("Registering first admin...");
    try {
      const payload = await requestJson<{
        token: string;
        membership: { tenant_id: string };
      }>(`${apiBaseUrl}/auth/register-first-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          name,
          tenant_name: tenantName,
          timezone: "UTC",
          plan: "starter"
        })
      });

      setToken(payload.token);
      setManualTokenInput(payload.token);
      setTenantId(payload.membership.tenant_id);
      setLoginPassword("");
      setStatus("First admin ready. You are signed in.");
      setActiveView("workspace");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not register first admin");
    } finally {
      setBusy(false);
    }
  }

  async function loginWithPassword(event: FormEvent) {
    event.preventDefault();

    const email = loginEmail.trim();
    const password = loginPassword;
    if (!email || !password) {
      setStatus("Enter email and password");
      return;
    }

    setBusy(true);
    setStatus("Signing in...");
    try {
      const payload = await requestJson<{
        token: string;
        active_membership: { tenant_id: string; role: string };
      }>(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          tenant_id: isUuid(tenantId) ? tenantId : undefined
        })
      });

      setToken(payload.token);
      setManualTokenInput(payload.token);
      if (payload.active_membership?.tenant_id) {
        setTenantId(payload.active_membership.tenant_id);
      }
      setLoginPassword("");
      setStatus(`Signed in as ${email}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function bootstrapDevToken(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("Issuing dev token...");
    try {
      const payload = await requestJson<{ token: string }>(`${apiBaseUrl}/internal/dev/token`, {
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

      setToken(payload.token);
      setManualTokenInput(payload.token);
      setStatus("Dev token ready");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not issue dev token");
    } finally {
      setBusy(false);
    }
  }

  async function loadTenants() {
    if (!token) {
      setStatus("Sign in first");
      return;
    }

    setBusy(true);
    setStatus("Loading tenants...");
    try {
      const payload = await requestJson<{ items: TenantRecord[] }>(`${apiBaseUrl}/internal/tenants`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTenants(payload.items);
      if (payload.items.length > 0 && !payload.items.some((tenant) => tenant.id === tenantId)) {
        setTenantId(payload.items[0].id);
      }
      setStatus(`Loaded ${payload.items.length} tenants`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load tenants");
    } finally {
      setBusy(false);
    }
  }

  async function createTenant(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setStatus("Sign in first");
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
      const tenant = await requestJson<TenantRecord>(`${apiBaseUrl}/internal/tenants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ name, timezone: "UTC", plan: "starter" })
      });

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
      setStatus("Sign in first");
      return;
    }
    if (!isUuid(targetTenantId)) {
      setStatus("Select a valid tenant first");
      return;
    }

    setBusy(true);
    setStatus("Loading agents...");
    try {
      const params = new URLSearchParams({ tenant_id: targetTenantId, limit: "200" });
      const payload = await requestJson<{ items: AgentRecord[] }>(`${apiBaseUrl}/internal/agents?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setAgents(payload.items);
      const keepSelected = payload.items.some((agent) => agent.id === selectedAgentId);
      const nextAgentId = keepSelected ? selectedAgentId : payload.items[0]?.id ?? "";
      setSelectedAgentId(nextAgentId);
      if (!nextAgentId) {
        setAgentVersions([]);
      }
      setStatus(`Loaded ${payload.items.length} agents`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load agents");
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(event: FormEvent) {
    event.preventDefault();
    if (!token) {
      setStatus("Sign in first");
      return;
    }
    if (!isUuid(tenantId)) {
      setStatus("Select a valid tenant first");
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
      const agent = await requestJson<AgentRecord>(`${apiBaseUrl}/internal/agents`, {
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
      const payload = await requestJson<{ items: AgentVersionRecord[] }>(
        `${apiBaseUrl}/internal/agents/${agentId}/versions`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      setAgentVersions(payload.items);
      setStatus(`Loaded ${payload.items.length} versions`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load agent versions");
    } finally {
      setBusy(false);
    }
  }

  async function createAgentVersion(event: FormEvent) {
    event.preventDefault();
    if (!token || !selectedAgentId) {
      setStatus("Select an agent and sign in first");
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
      await requestJson(`${apiBaseUrl}/internal/agents/${selectedAgentId}/versions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ system_prompt: prompt, temperature })
      });

      await loadAgentVersions(selectedAgentId);
      setStatus("Agent version created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create version");
    } finally {
      setBusy(false);
    }
  }

  async function publishAgentVersion(versionId: string) {
    if (!token || !selectedAgentId) {
      setStatus("Select an agent and sign in first");
      return;
    }

    setBusy(true);
    setStatus("Publishing version...");
    try {
      await requestJson(`${apiBaseUrl}/internal/agents/${selectedAgentId}/versions/${versionId}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });

      await loadAgentVersions(selectedAgentId);
      setStatus("Version published");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not publish version");
    } finally {
      setBusy(false);
    }
  }

  async function loadDashboard() {
    if (!token) {
      setStatus("Sign in first");
      return;
    }

    setBusy(true);
    setStatus("Loading KPI and calls...");
    try {
      const query = buildClientQuery().toString();
      const callsUrl = `${apiBaseUrl}/client/calls${query ? `?${query}` : ""}`;
      const kpisUrl = `${apiBaseUrl}/client/kpis${query ? `?${query}` : ""}`;

      const [callsPayload, kpisPayload] = await Promise.all([
        requestJson<{ items: CallRecord[] }>(callsUrl, { headers: { Authorization: `Bearer ${token}` } }),
        requestJson<{ items: KpiRecord[] }>(kpisUrl, { headers: { Authorization: `Bearer ${token}` } })
      ]);

      setCalls(callsPayload.items);
      setKpis(kpisPayload.items);

      const keepSelection = callsPayload.items.some((call) => call.id === selectedCallId);
      const nextCallId = keepSelection ? selectedCallId : callsPayload.items[0]?.id ?? "";
      setSelectedCallId(nextCallId);
      if (!nextCallId) {
        setEvents([]);
      }

      setStatus(`Loaded ${callsPayload.items.length} calls and ${kpisPayload.items.length} KPI rows`);
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
      const payload = await requestJson<{ items: CallEvent[] }>(`${apiBaseUrl}/internal/calls/${callId}/events`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setEvents(payload.items);
      setStatus(`Loaded ${payload.items.length} events`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load events");
    } finally {
      setBusy(false);
    }
  }

  async function checkConnectorMode() {
    setBusy(true);
    setStatus("Checking connector mode...");
    try {
      const payload = await requestJson<{ mode: string }>(`${connectorUrl}/runtime/ai-mode`, {
        headers: { Authorization: `Bearer ${connectorToken}` }
      });
      setConnectorMode(payload.mode);
      setStatus(`Connector mode: ${payload.mode}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not read connector mode");
    } finally {
      setBusy(false);
    }
  }

  async function sendUserTurn() {
    if (!selectedCallId) {
      setStatus("Select a call first");
      return;
    }

    const text = userTurn.trim();
    if (!text) {
      setStatus("Write a user message first");
      return;
    }

    setBusy(true);
    setStatus("Sending user turn to connector...");
    try {
      await requestJson(`${connectorUrl}/runtime/sessions/${selectedCallId}/user-turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${connectorToken}`
        },
        body: JSON.stringify({ text })
      });

      await loadEvents(selectedCallId);
      setStatus("User turn processed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send user turn");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!token || autoRefreshSeconds <= 0 || activeView !== "operations") {
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
  }, [activeView, autoRefreshSeconds, selectedCallId, token, apiBaseUrl, fromDate, toDate, agentFilter]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Voice Agent SaaS</p>
          <h1>Operator Portal</h1>
          <p className="muted">Administra clientes, agentes y operacion desde un flujo separado por modulo.</p>
        </div>

        <nav className="nav-grid">
          <button className={activeView === "workspace" ? "active" : ""} onClick={() => setActiveView("workspace")} type="button">
            Workspace
          </button>
          <button className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")} type="button">
            Agent Builder
          </button>
          <button className={activeView === "operations" ? "active" : ""} onClick={() => setActiveView("operations")} type="button">
            Operations
          </button>
        </nav>

        <div className="sidebar-meta">
          <small>
            <strong>Tenant:</strong> {tenantId || "-"}
          </small>
          <small>
            <strong>User:</strong> {tokenClaims?.sub ?? "not signed"}
          </small>
          <small>
            <strong>Role:</strong> {tokenClaims?.role ?? "-"}
          </small>
        </div>
      </aside>

      <main className="content">
        <header className="content-header">
          <div>
            <h2>
              {activeView === "workspace"
                ? "Workspace Setup"
                : activeView === "agents"
                  ? "Agent Builder"
                  : "Operations Console"}
            </h2>
            <p>
              {activeView === "workspace"
                ? "Sign-in, tenant onboarding and security setup."
                : activeView === "agents"
                  ? "Create agents, version prompts, and publish production behavior."
                  : "Monitor KPI health, call timelines, and runtime connector behavior."}
            </p>
          </div>
          <span className={`status-pill ${busy ? "busy" : ""}`}>{busy ? "Working" : "Idle"}</span>
        </header>

        <section className="status-panel">
          <span>
            Auth: <strong>{token ? "Ready" : "Missing token"}</strong>
          </span>
          <span>
            JWT: <code>{token ? `${token.slice(0, 30)}...` : "not issued"}</code>
          </span>
          <span>Status: {status}</span>
        </section>

        {activeView === "workspace" ? (
          <>
            <section className="panel">
              <div className="panel-title-row">
                <h3>Portal Sign-In</h3>
                <small>No necesitas pegar JWT manual para uso normal.</small>
              </div>

              <form className="form-grid" onSubmit={loginWithPassword}>
                <label>
                  API Base URL
                  <input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} />
                </label>
                <label>
                  Email
                  <input value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@company.com" />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(event) => setLoginPassword(event.target.value)}
                    placeholder="your password"
                  />
                </label>
                <button disabled={busy} type="submit">
                  Sign In
                </button>
              </form>

              <form className="form-grid soft" onSubmit={registerFirstAdmin}>
                <label>
                  First admin name
                  <input
                    value={firstAdminName}
                    onChange={(event) => setFirstAdminName(event.target.value)}
                    placeholder="Owner"
                  />
                </label>
                <label>
                  First tenant name
                  <input
                    value={firstAdminTenantName}
                    onChange={(event) => setFirstAdminTenantName(event.target.value)}
                    placeholder="My Company"
                  />
                </label>
                <button disabled={busy} type="submit">
                  Register First Admin
                </button>
              </form>
            </section>

            <section className="panel">
              <div className="panel-title-row">
                <h3>Tenant Workspace</h3>
                <small>Crea clientes y selecciona el tenant activo.</small>
              </div>

              <div className="form-grid">
                <label>
                  Tenant
                  <select value={tenantId} onChange={(event) => setTenantId(event.target.value)}>
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
              </div>

              <form className="form-grid soft" onSubmit={createTenant}>
                <label>
                  New tenant name
                  <input
                    value={newTenantName}
                    onChange={(event) => setNewTenantName(event.target.value)}
                    placeholder="Acme Dental"
                  />
                </label>
                <button disabled={busy || !token} type="submit">
                  Create Tenant
                </button>
              </form>
            </section>

            <section className="panel">
              <details>
                <summary>Advanced token tools (dev and emergency fallback)</summary>
                <form className="form-grid" onSubmit={bootstrapDevToken}>
                  <label>
                    Dev bootstrap key
                    <input value={bootstrapKey} onChange={(event) => setBootstrapKey(event.target.value)} />
                  </label>
                  <button disabled={busy} type="submit">
                    Issue Dev JWT
                  </button>
                </form>

                <div className="form-grid">
                  <label>
                    Manual JWT
                    <input
                      value={manualTokenInput}
                      onChange={(event) => setManualTokenInput(event.target.value)}
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
              </details>

              {usingLocalhostApi ? (
                <p className="warning">Estas en Railway pero el API apunta a localhost. Cambia a tu dominio publico.</p>
              ) : null}
            </section>
          </>
        ) : null}

        {activeView === "agents" ? (
          <>
            <section className="panel">
              <div className="panel-title-row">
                <h3>Agent Catalog</h3>
                <small>Define configuracion base por tenant.</small>
              </div>

              <div className="form-grid">
                <label>
                  Active tenant
                  <select
                    value={tenantId}
                    onChange={(event) => {
                      setTenantId(event.target.value);
                      setSelectedAgentId("");
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
                <button disabled={busy || !token} onClick={() => void loadAgents()} type="button">
                  Load Agents
                </button>
              </div>

              <form className="form-grid soft" onSubmit={createAgent}>
                <label>
                  Agent name
                  <input
                    value={newAgentName}
                    onChange={(event) => setNewAgentName(event.target.value)}
                    placeholder="Reception Bot"
                  />
                </label>
                <label>
                  Language
                  <input value={newAgentLanguage} onChange={(event) => setNewAgentLanguage(event.target.value)} />
                </label>
                <label>
                  LLM
                  <input value={newAgentLlmModel} onChange={(event) => setNewAgentLlmModel(event.target.value)} />
                </label>
                <label>
                  STT
                  <input value={newAgentSttProvider} onChange={(event) => setNewAgentSttProvider(event.target.value)} />
                </label>
                <label>
                  TTS
                  <input value={newAgentTtsProvider} onChange={(event) => setNewAgentTtsProvider(event.target.value)} />
                </label>
                <button disabled={busy || !token || !isUuid(tenantId)} type="submit">
                  Create Agent
                </button>
              </form>
            </section>

            <section className="split-panel">
              <div className="panel">
                <div className="panel-title-row">
                  <h3>Agents</h3>
                  <small>{agents.length} loaded</small>
                </div>
                <ul className="entity-list">
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
                        <strong>{agent.name}</strong>
                        <small>{agent.id}</small>
                        <small>
                          {agent.stt_provider} / {agent.tts_provider}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="panel">
                <div className="panel-title-row">
                  <h3>Versioning</h3>
                  <small>{selectedAgent ? selectedAgent.name : "Select an agent"}</small>
                </div>

                {selectedAgent ? (
                  <>
                    <form className="form-grid" onSubmit={createAgentVersion}>
                      <label>
                        System prompt
                        <input
                          value={newVersionPrompt}
                          onChange={(event) => setNewVersionPrompt(event.target.value)}
                          placeholder="Prompt para el agente"
                        />
                      </label>
                      <label>
                        Temperature
                        <input
                          value={newVersionTemperature}
                          onChange={(event) => setNewVersionTemperature(event.target.value)}
                          placeholder="0.3"
                        />
                      </label>
                      <button disabled={busy || !token} type="submit">
                        Create Version
                      </button>
                    </form>

                    <div className="versions-grid">
                      {agentVersions.map((version) => (
                        <article key={version.id} className="version-card">
                          <div className="panel-title-row">
                            <strong>v{version.version}</strong>
                            {version.published_at ? (
                              <span className="badge on">published</span>
                            ) : (
                              <button disabled={busy || !token} onClick={() => void publishAgentVersion(version.id)} type="button">
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
                  <p className="muted">Select an agent to manage versions and publish behavior.</p>
                )}
              </div>
            </section>
          </>
        ) : null}

        {activeView === "operations" ? (
          <>
            <section className="panel">
              <div className="panel-title-row">
                <h3>Operational Filters</h3>
                <small>KPIs, call list, and timeline share these filters.</small>
              </div>
              <div className="form-grid">
                <label>
                  From
                  <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
                </label>
                <label>
                  To
                  <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
                </label>
                <label>
                  Agent ID (optional)
                  <input value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} placeholder="uuid" />
                </label>
                <label>
                  Auto refresh
                  <select
                    value={String(autoRefreshSeconds)}
                    onChange={(event) => setAutoRefreshSeconds(Number(event.target.value))}
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
                <h3>Total Calls</h3>
                <strong>{totals.totalCalls}</strong>
                <small>Aggregated from daily_kpis</small>
              </article>
              <article className="kpi-card">
                <h3>Average Duration</h3>
                <strong>{formatSeconds(totals.avgDurationSec)}</strong>
                <small>Weighted by call volume</small>
              </article>
              <article className="kpi-card">
                <h3>Resolution Rate</h3>
                <strong>{totals.resolutionRate.toFixed(2)}%</strong>
                <small>Outcome = resolved</small>
              </article>
              <article className="kpi-card">
                <h3>Handoff Rate</h3>
                <strong>{totals.handoffRate.toFixed(2)}%</strong>
                <small>Handoff or reason present</small>
              </article>
              <article className="kpi-card">
                <h3>Total Cost</h3>
                <strong>{usdFormatter.format(totals.totalCost)}</strong>
                <small>Summed from KPI rows</small>
              </article>
              <article className="kpi-card">
                <h3>Active Calls</h3>
                <strong>{totals.activeCalls}</strong>
                <small>Open calls in current list</small>
              </article>
            </section>

            <section className="panel">
              <div className="panel-title-row">
                <h3>Connector Controls</h3>
                <small>Use for runtime checks and simulated turns.</small>
              </div>
              <div className="form-grid">
                <label>
                  Connector URL
                  <input value={connectorUrl} onChange={(event) => setConnectorUrl(event.target.value)} />
                </label>
                <label>
                  Connector Token
                  <input value={connectorToken} onChange={(event) => setConnectorToken(event.target.value)} />
                </label>
                <label>
                  Simulated user turn
                  <input value={userTurn} onChange={(event) => setUserTurn(event.target.value)} />
                </label>
                <button disabled={busy || !selectedCallId} onClick={() => void sendUserTurn()} type="button">
                  Send User Turn
                </button>
                <button disabled={busy} onClick={() => void checkConnectorMode()} type="button">
                  Check AI Mode
                </button>
              </div>
              <p className="muted">Connector mode: {connectorMode}</p>
            </section>

            <section className="split-panel">
              <div className="panel">
                <div className="panel-title-row">
                  <h3>Calls</h3>
                  <small>{calls.length} loaded</small>
                </div>
                <ul className="entity-list long">
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
                          <div className="row-inline">
                            <strong>{call.twilio_call_sid}</strong>
                            <span className={`badge ${isActive ? "on" : "off"}`}>{isActive ? "active" : "ended"}</span>
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

              <div className="panel">
                <div className="panel-title-row">
                  <h3>Timeline</h3>
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
                        <p className="muted">No events loaded yet.</p>
                      ) : (
                        events.map((event) => (
                          <article key={event.id}>
                            <h4>{event.type}</h4>
                            <small>
                              {formatDateTime(event.ts)} | attempts={event.processing_attempts} | processed={
                                event.processed_at ? "yes" : "no"
                              }
                            </small>
                            {event.last_error ? <small className="danger">last_error={event.last_error}</small> : null}
                            <pre>{JSON.stringify(event.payload_json, null, 2)}</pre>
                          </article>
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted">Select a call to inspect timeline events.</p>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-title-row">
                <h3>KPI Rows</h3>
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
          </>
        ) : null}
      </main>
    </div>
  );
}
