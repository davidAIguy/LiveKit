import { FormEvent, useEffect, useMemo, useState } from "react";

type NumericLike = number | string | null;
type ViewKey = "clients" | "agents" | "operations";
type AuthMode = "signin" | "setup";
type WizardStep = 1 | 2 | 3;

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
  greeting_text: string | null;
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

type PhoneNumberRecord = {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  twilio_sid: string;
  e164: string;
  status: string;
  created_at: string;
  agent_name: string | null;
};

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

type CallEvent = {
  id: string;
  ts: string;
  type: string;
  payload_json: unknown;
  processing_attempts: number;
  processed_at: string | null;
  last_error: string | null;
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

type TenantSnapshot = {
  calls: number;
  activeCalls: number;
  resolvedCalls: number;
  handoffCalls: number;
  lastStartedAt: string | null;
};

type PersistedConfig = {
  apiBaseUrl: string;
  token: string;
  loginEmail: string;
  tenantId: string;
  activeView: ViewKey;
  tenantSearch: string;
  fromDate: string;
  toDate: string;
  agentFilter: string;
  autoRefreshSeconds: number;
};

const storageKey = "ops-portal.config.v1";
const defaultTenant = "11111111-1111-1111-1111-111111111111";

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

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
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
    throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
  }

  return (await response.json()) as T;
}

function summarizeCalls(
  items: Array<{ started_at: string; ended_at: string | null; outcome: string | null; handoff_reason: string | null }>
): TenantSnapshot {
  return {
    calls: items.length,
    activeCalls: items.filter((item) => !item.ended_at).length,
    resolvedCalls: items.filter((item) => item.outcome === "resolved").length,
    handoffCalls: items.filter((item) => item.outcome === "handoff" || Boolean(item.handoff_reason)).length,
    lastStartedAt: items[0]?.started_at ?? null
  };
}

export function App() {
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");

  const [apiBaseUrl, setApiBaseUrl] = useState("http://localhost:4000");
  const [token, setToken] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [setupName, setSetupName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupTenantName, setSetupTenantName] = useState("My Company");

  const [activeView, setActiveView] = useState<ViewKey>("clients");
  const [tenantId, setTenantId] = useState(defaultTenant);
  const [tenantSearch, setTenantSearch] = useState("");

  const [tenants, setTenants] = useState<TenantRecord[]>([]);
  const [tenantSnapshots, setTenantSnapshots] = useState<Record<string, TenantSnapshot>>({});
  const [newTenantName, setNewTenantName] = useState("");

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [agentVersions, setAgentVersions] = useState<AgentVersionRecord[]>([]);
  const [editAgentGreeting, setEditAgentGreeting] = useState("");
  const [editAgentVoiceId, setEditAgentVoiceId] = useState("");

  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumberRecord[]>([]);
  const [newPhoneE164, setNewPhoneE164] = useState("");
  const [newPhoneTwilioSid, setNewPhoneTwilioSid] = useState("");
  const [newPhoneAgentId, setNewPhoneAgentId] = useState("");
  const [phoneAgentDrafts, setPhoneAgentDrafts] = useState<Record<string, string>>({});

  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentLanguage, setNewAgentLanguage] = useState("es");
  const [newAgentLlmModel, setNewAgentLlmModel] = useState("gpt-4o-mini");
  const [newAgentSttProvider, setNewAgentSttProvider] = useState("deepgram");
  const [newAgentTtsProvider, setNewAgentTtsProvider] = useState("rime");
  const [newAgentVoiceId, setNewAgentVoiceId] = useState("");
  const [newAgentGreeting, setNewAgentGreeting] = useState("");
  const [wizardCreateVersion, setWizardCreateVersion] = useState(true);
  const [wizardPublishNow, setWizardPublishNow] = useState(true);
  const [newVersionPrompt, setNewVersionPrompt] = useState(
    "Eres un agente de voz profesional. Responde de forma clara y breve en espanol."
  );
  const [newVersionTemperature, setNewVersionTemperature] = useState("0.3");

  const [fromDate, setFromDate] = useState(toLocalDate(7));
  const [toDate, setToDate] = useState(toLocalDate(0));
  const [agentFilter, setAgentFilter] = useState("");
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState(0);

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [kpis, setKpis] = useState<KpiRecord[]>([]);
  const [selectedCallId, setSelectedCallId] = useState("");
  const [events, setEvents] = useState<CallEvent[]>([]);

  const tokenClaims = useMemo(() => parseJwtClaims(token), [token]);

  const tenantOptions = useMemo(() => {
    const list = [...tenants];
    if (tenantId && !list.some((tenant) => tenant.id === tenantId)) {
      list.unshift({
        id: tenantId,
        name: `Current tenant (${tenantId.slice(0, 8)}...)`,
        status: "unknown",
        timezone: "UTC",
        plan: "unknown",
        created_at: new Date(0).toISOString()
      });
    }
    return list;
  }, [tenantId, tenants]);

  const filteredTenants = useMemo(() => {
    const query = tenantSearch.trim().toLowerCase();
    if (!query) {
      return tenantOptions;
    }

    return tenantOptions.filter((tenant) => {
      return (
        tenant.name.toLowerCase().includes(query) ||
        tenant.id.toLowerCase().includes(query) ||
        tenant.plan.toLowerCase().includes(query)
      );
    });
  }, [tenantOptions, tenantSearch]);

  const activeTenant = useMemo(
    () => tenantOptions.find((tenant) => tenant.id === tenantId) ?? null,
    [tenantOptions, tenantId]
  );

  const activeTenantSnapshot = useMemo(() => tenantSnapshots[tenantId] ?? null, [tenantId, tenantSnapshots]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  useEffect(() => {
    if (!selectedAgent) {
      setEditAgentGreeting("");
      setEditAgentVoiceId("");
      return;
    }

    setEditAgentGreeting(selectedAgent.greeting_text ?? "");
    setEditAgentVoiceId(selectedAgent.voice_id ?? "");
  }, [selectedAgent]);

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

    return {
      totalCalls,
      avgDurationSec: totalCalls > 0 ? weightedDuration / totalCalls : 0,
      resolutionRate: totalCalls > 0 ? weightedResolution / totalCalls : 0,
      handoffRate: totalCalls > 0 ? weightedHandoff / totalCalls : 0,
      totalCost,
      activeCalls: calls.filter((call) => !call.ended_at).length
    };
  }, [calls, kpis]);

  const wizardTemperature = Number(newVersionTemperature);
  const wizardTemperatureValid = Number.isFinite(wizardTemperature) && wizardTemperature >= 0 && wizardTemperature <= 2;
  const wizardCanSubmit =
    newAgentName.trim().length >= 2 &&
    isUuid(tenantId) &&
    (!wizardCreateVersion || (newVersionPrompt.trim().length >= 10 && wizardTemperatureValid));

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
      if (typeof parsed.token === "string") {
        setToken(parsed.token);
      }
      if (typeof parsed.loginEmail === "string") {
        setLoginEmail(parsed.loginEmail);
      }
      if (typeof parsed.tenantId === "string") {
        setTenantId(parsed.tenantId);
      }
      if (parsed.activeView === "clients" || parsed.activeView === "agents" || parsed.activeView === "operations") {
        setActiveView(parsed.activeView);
      }
      if (typeof parsed.tenantSearch === "string") {
        setTenantSearch(parsed.tenantSearch);
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
      if (typeof parsed.autoRefreshSeconds === "number") {
        setAutoRefreshSeconds(parsed.autoRefreshSeconds);
      }
    } catch {
      // ignore malformed localStorage
    }
  }, []);

  useEffect(() => {
    const payload: PersistedConfig = {
      apiBaseUrl,
      token,
      loginEmail,
      tenantId,
      activeView,
      tenantSearch,
      fromDate,
      toDate,
      agentFilter,
      autoRefreshSeconds
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [apiBaseUrl, token, loginEmail, tenantId, activeView, tenantSearch, fromDate, toDate, agentFilter, autoRefreshSeconds]);

  useEffect(() => {
    if (!token || autoRefreshSeconds <= 0 || activeView !== "operations") {
      return;
    }

    const timer = window.setInterval(() => {
      void loadOperations();
      if (selectedCallId) {
        void loadCallEvents(selectedCallId);
      }
    }, autoRefreshSeconds * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [token, autoRefreshSeconds, activeView, selectedCallId, apiBaseUrl, fromDate, toDate, agentFilter]);

  function buildClientQuery(): URLSearchParams {
    const params = new URLSearchParams();
    const fromIso = buildIsoFromDate(fromDate, false);
    const toIso = buildIsoFromDate(toDate, true);
    const trimmedAgentFilter = agentFilter.trim();

    if (fromIso) {
      params.set("from", fromIso);
    }
    if (toIso) {
      params.set("to", toIso);
    }
    if (trimmedAgentFilter && isUuid(trimmedAgentFilter)) {
      params.set("agent_id", trimmedAgentFilter);
    }

    return params;
  }

  function selectTenant(nextTenantId: string): void {
    setTenantId(nextTenantId);
    setSelectedAgentId("");
    setAgentVersions([]);
    setPhoneNumbers([]);
    setPhoneAgentDrafts({});
  }

  async function fetchTenants(): Promise<TenantRecord[]> {
    const payload = await requestJson<{ items: TenantRecord[] }>(`${apiBaseUrl}/internal/tenants`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return payload.items;
  }

  async function fetchAgentsByTenant(targetTenantId: string): Promise<AgentRecord[]> {
    const params = new URLSearchParams({ tenant_id: targetTenantId, limit: "200" });
    const payload = await requestJson<{ items: AgentRecord[] }>(`${apiBaseUrl}/internal/agents?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return payload.items;
  }

  async function fetchPhoneNumbersByTenant(targetTenantId: string): Promise<PhoneNumberRecord[]> {
    const params = new URLSearchParams({ tenant_id: targetTenantId, limit: "200" });
    const payload = await requestJson<{ items: PhoneNumberRecord[] }>(
      `${apiBaseUrl}/internal/phone-numbers?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    return payload.items;
  }

  async function fetchVersionsByAgent(agentId: string): Promise<AgentVersionRecord[]> {
    const payload = await requestJson<{ items: AgentVersionRecord[] }>(`${apiBaseUrl}/internal/agents/${agentId}/versions`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return payload.items;
  }

  async function loadTenants(): Promise<void> {
    if (!token) {
      setStatus("Sign in first");
      return;
    }

    setBusy(true);
    setStatus("Loading tenants...");
    try {
      const items = await fetchTenants();
      setTenants(items);
      if (items.length > 0 && !items.some((tenant) => tenant.id === tenantId)) {
        setTenantId(items[0].id);
      }
      setStatus(`Loaded ${items.length} tenants`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load tenants");
    } finally {
      setBusy(false);
    }
  }

  async function loadTenantSnapshot(targetTenantId = tenantId): Promise<void> {
    if (!token) {
      setStatus("Sign in first");
      return;
    }
    if (!isUuid(targetTenantId)) {
      setStatus("Select a valid tenant first");
      return;
    }

    setBusy(true);
    setStatus("Loading tenant snapshot...");
    try {
      const params = new URLSearchParams({ tenant_id: targetTenantId, limit: "200" });
      const payload = await requestJson<{
        items: Array<{ started_at: string; ended_at: string | null; outcome: string | null; handoff_reason: string | null }>;
      }>(`${apiBaseUrl}/internal/calls?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const summary = summarizeCalls(payload.items);
      setTenantSnapshots((current) => ({ ...current, [targetTenantId]: summary }));
      setStatus(`Tenant snapshot loaded (${summary.calls} calls)`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load tenant snapshot");
    } finally {
      setBusy(false);
    }
  }

  async function createTenant(event: FormEvent): Promise<void> {
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

      setTenants((current) => [tenant, ...current]);
      setNewTenantName("");
      selectTenant(tenant.id);
      setStatus(`Tenant created: ${tenant.name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create tenant");
    } finally {
      setBusy(false);
    }
  }

  async function loadAgents(targetTenantId = tenantId): Promise<void> {
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
      const items = await fetchAgentsByTenant(targetTenantId);
      setAgents(items);
      if (newPhoneAgentId && !items.some((agent) => agent.id === newPhoneAgentId)) {
        setNewPhoneAgentId("");
      }
      const keepSelected = items.some((agent) => agent.id === selectedAgentId);
      const nextAgentId = keepSelected ? selectedAgentId : items[0]?.id ?? "";
      setSelectedAgentId(nextAgentId);
      if (!nextAgentId) {
        setAgentVersions([]);
      }
      setStatus(`Loaded ${items.length} agents`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load agents");
    } finally {
      setBusy(false);
    }
  }

  async function loadPhoneNumbers(targetTenantId = tenantId): Promise<void> {
    if (!token) {
      setStatus("Sign in first");
      return;
    }
    if (!isUuid(targetTenantId)) {
      setStatus("Select a valid tenant first");
      return;
    }

    setBusy(true);
    setStatus("Loading phone numbers...");
    try {
      const items = await fetchPhoneNumbersByTenant(targetTenantId);
      setPhoneNumbers(items);

      const draftMap: Record<string, string> = {};
      for (const item of items) {
        draftMap[item.id] = item.agent_id ?? "";
      }
      setPhoneAgentDrafts(draftMap);

      setStatus(`Loaded ${items.length} phone numbers`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load phone numbers");
    } finally {
      setBusy(false);
    }
  }

  async function createPhoneNumber(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (!token) {
      setStatus("Sign in first");
      return;
    }
    if (!isUuid(tenantId)) {
      setStatus("Select a valid tenant first");
      return;
    }

    const e164 = newPhoneE164.trim();
    const twilioSid = newPhoneTwilioSid.trim();
    if (!e164 || !twilioSid) {
      setStatus("Enter both E.164 number and Twilio SID");
      return;
    }

    setBusy(true);
    setStatus("Creating phone number...");
    try {
      await requestJson<PhoneNumberRecord>(`${apiBaseUrl}/internal/phone-numbers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          e164,
          twilio_sid: twilioSid,
          agent_id: newPhoneAgentId || null,
          status: "active"
        })
      });

      setNewPhoneE164("");
      setNewPhoneTwilioSid("");
      setNewPhoneAgentId("");

      await loadPhoneNumbers(tenantId);
      setStatus("Phone number created");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create phone number");
    } finally {
      setBusy(false);
    }
  }

  async function assignPhoneNumberAgent(phoneNumberId: string): Promise<void> {
    if (!token) {
      setStatus("Sign in first");
      return;
    }

    const draftAgentId = phoneAgentDrafts[phoneNumberId] ?? "";

    setBusy(true);
    setStatus("Updating phone routing...");
    try {
      await requestJson<PhoneNumberRecord>(`${apiBaseUrl}/internal/phone-numbers/${phoneNumberId}/agent`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          agent_id: draftAgentId || null
        })
      });

      await loadPhoneNumbers(tenantId);
      setStatus("Phone routing updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not update phone routing");
    } finally {
      setBusy(false);
    }
  }

  async function loadAgentVersions(agentId: string): Promise<void> {
    if (!token || !agentId) {
      return;
    }

    setBusy(true);
    setStatus("Loading agent versions...");
    try {
      const items = await fetchVersionsByAgent(agentId);
      setAgentVersions(items);
      setStatus(`Loaded ${items.length} versions`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load versions");
    } finally {
      setBusy(false);
    }
  }

  async function createAgentWorkflow(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (!token) {
      setStatus("Sign in first");
      return;
    }
    if (!wizardCanSubmit) {
      setStatus("Please complete the required wizard fields");
      return;
    }

    setBusy(true);
    setStatus("Creating agent workflow...");
    try {
      const agent = await requestJson<AgentRecord>(`${apiBaseUrl}/internal/agents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          tenant_id: tenantId,
          name: newAgentName.trim(),
          language: newAgentLanguage,
          llm_model: newAgentLlmModel,
          stt_provider: newAgentSttProvider,
          tts_provider: newAgentTtsProvider,
          voice_id: newAgentVoiceId.trim() || undefined,
          greeting_text: newAgentGreeting.trim() || undefined
        })
      });

      if (wizardCreateVersion) {
        const version = await requestJson<AgentVersionRecord>(`${apiBaseUrl}/internal/agents/${agent.id}/versions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({
            system_prompt: newVersionPrompt.trim(),
            temperature: wizardTemperature
          })
        });

        if (wizardPublishNow) {
          await requestJson(`${apiBaseUrl}/internal/agents/${agent.id}/versions/${version.id}/publish`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
          });
        }
      }

      const updatedAgents = await fetchAgentsByTenant(tenantId);
      setAgents(updatedAgents);
      setSelectedAgentId(agent.id);

      const updatedVersions = await fetchVersionsByAgent(agent.id);
      setAgentVersions(updatedVersions);

      setWizardStep(1);
      setNewAgentName("");
      setNewAgentVoiceId("");
      setNewAgentGreeting("");

      setStatus(
        wizardCreateVersion
          ? wizardPublishNow
            ? `Agent ${agent.name} created and published`
            : `Agent ${agent.name} created with draft version`
          : `Agent ${agent.name} created`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create agent workflow");
    } finally {
      setBusy(false);
    }
  }

  async function publishVersion(versionId: string): Promise<void> {
    if (!token || !selectedAgentId) {
      setStatus("Select an agent first");
      return;
    }

    setBusy(true);
    setStatus("Publishing version...");
    try {
      await requestJson(`${apiBaseUrl}/internal/agents/${selectedAgentId}/versions/${versionId}/publish`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });

      const items = await fetchVersionsByAgent(selectedAgentId);
      setAgentVersions(items);
      setStatus("Version published");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not publish version");
    } finally {
      setBusy(false);
    }
  }

  async function updateSelectedAgentSettings(event: FormEvent): Promise<void> {
    event.preventDefault();

    if (!token || !selectedAgentId) {
      setStatus("Select an agent first");
      return;
    }

    setBusy(true);
    setStatus("Saving agent settings...");

    try {
      const payload: {
        greeting_text: string | null;
        voice_id: string | null;
      } = {
        greeting_text: editAgentGreeting.trim() || null,
        voice_id: editAgentVoiceId.trim() || null
      };

      await requestJson<AgentRecord>(`${apiBaseUrl}/internal/agents/${selectedAgentId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const updatedAgents = await fetchAgentsByTenant(tenantId);
      setAgents(updatedAgents);
      setStatus("Agent settings saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save agent settings");
    } finally {
      setBusy(false);
    }
  }

  async function loadOperations(): Promise<void> {
    if (!token) {
      setStatus("Sign in first");
      return;
    }

    setBusy(true);
    setStatus("Loading operations...");
    try {
      const query = buildClientQuery().toString();
      const [callsPayload, kpisPayload] = await Promise.all([
        requestJson<{ items: CallRecord[] }>(`${apiBaseUrl}/client/calls${query ? `?${query}` : ""}`, {
          headers: { Authorization: `Bearer ${token}` }
        }),
        requestJson<{ items: KpiRecord[] }>(`${apiBaseUrl}/client/kpis${query ? `?${query}` : ""}`, {
          headers: { Authorization: `Bearer ${token}` }
        })
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
      setStatus(error instanceof Error ? error.message : "Could not load operations");
    } finally {
      setBusy(false);
    }
  }

  async function loadCallEvents(callId: string): Promise<void> {
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
      setStatus(error instanceof Error ? error.message : "Could not load call timeline");
    } finally {
      setBusy(false);
    }
  }

  async function loginWithPassword(event: FormEvent): Promise<void> {
    event.preventDefault();

    const email = loginEmail.trim();
    if (!email || !loginPassword) {
      setStatus("Enter email and password");
      return;
    }

    setBusy(true);
    setStatus("Signing in...");
    try {
      const payload = await requestJson<{
        token: string;
        active_membership?: { tenant_id: string };
      }>(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password: loginPassword,
          tenant_id: isUuid(tenantId) ? tenantId : undefined
        })
      });

      setToken(payload.token);
      if (payload.active_membership?.tenant_id) {
        setTenantId(payload.active_membership.tenant_id);
      }
      setLoginPassword("");
      setStatus(`Signed in as ${email}`);

      const loadedTenants = await fetchTenants();
      setTenants(loadedTenants);
      if (loadedTenants.length > 0 && !loadedTenants.some((tenant) => tenant.id === tenantId)) {
        setTenantId(loadedTenants[0].id);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  async function registerFirstAdmin(event: FormEvent): Promise<void> {
    event.preventDefault();

    const name = setupName.trim();
    const email = setupEmail.trim();
    const tenantName = setupTenantName.trim();
    if (!name || !email || !setupPassword || !tenantName) {
      setStatus("Complete all setup fields");
      return;
    }

    setBusy(true);
    setStatus("Creating first admin...");
    try {
      const payload = await requestJson<{
        token: string;
        membership: { tenant_id: string };
      }>(`${apiBaseUrl}/auth/register-first-admin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          name,
          password: setupPassword,
          tenant_name: tenantName,
          timezone: "UTC",
          plan: "starter"
        })
      });

      setToken(payload.token);
      setTenantId(payload.membership.tenant_id);
      setLoginEmail(email);
      setStatus("First admin created. You are signed in.");

      const loadedTenants = await fetchTenants();
      setTenants(loadedTenants);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not complete setup");
    } finally {
      setBusy(false);
    }
  }

  function logout(): void {
    setToken("");
    setLoginPassword("");
    setStatus("Signed out");
  }

  if (!token) {
    return (
      <div className="auth-shell">
        <section className="auth-brand">
          <p className="tag">Voice Agent SaaS</p>
          <h1>Operator Portal</h1>
          <p>
            Un solo lugar para administrar clientes, crear agentes y monitorear llamadas. Sin copiar JWT ni pasos tecnicos.
          </p>
          <ul>
            <li>Login con email/password</li>
            <li>Setup inicial de primer admin</li>
            <li>Panel modular por dominio: clientes, agentes, operaciones</li>
          </ul>
        </section>

        <section className="auth-card">
          <header>
            <h2>{authMode === "signin" ? "Sign In" : "First-Time Setup"}</h2>
            <p>{authMode === "signin" ? "Accede con tus credenciales" : "Crea el primer admin y tenant"}</p>
          </header>

          <div className="auth-switch">
            <button className={authMode === "signin" ? "active" : ""} onClick={() => setAuthMode("signin")} type="button">
              Sign In
            </button>
            <button className={authMode === "setup" ? "active" : ""} onClick={() => setAuthMode("setup")} type="button">
              First Setup
            </button>
          </div>

          {authMode === "signin" ? (
            <form className="auth-form" onSubmit={loginWithPassword}>
              <label>
                API endpoint
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
                {busy ? "Signing in..." : "Sign In"}
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={registerFirstAdmin}>
              <label>
                API endpoint
                <input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} />
              </label>
              <label>
                Admin name
                <input value={setupName} onChange={(event) => setSetupName(event.target.value)} placeholder="Owner" />
              </label>
              <label>
                Admin email
                <input value={setupEmail} onChange={(event) => setSetupEmail(event.target.value)} placeholder="owner@company.com" />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={setupPassword}
                  onChange={(event) => setSetupPassword(event.target.value)}
                  placeholder="minimum 10 chars"
                />
              </label>
              <label>
                Tenant name
                <input
                  value={setupTenantName}
                  onChange={(event) => setSetupTenantName(event.target.value)}
                  placeholder="My Company"
                />
              </label>
              <button disabled={busy} type="submit">
                {busy ? "Setting up..." : "Create Admin"}
              </button>
            </form>
          )}

          <footer>
            <strong>Status:</strong> {status}
          </footer>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div>
          <p className="tag">Voice Agent SaaS</p>
          <h1>Operator Portal</h1>
          <p>Manage clients, build agents, and monitor calls.</p>
        </div>

        <nav>
          <button className={activeView === "clients" ? "active" : ""} onClick={() => setActiveView("clients")} type="button">
            Clients
          </button>
          <button className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")} type="button">
            Agents
          </button>
          <button
            className={activeView === "operations" ? "active" : ""}
            onClick={() => setActiveView("operations")}
            type="button"
          >
            Operations
          </button>
        </nav>

        <div className="sidebar-foot">
          <small>
            <strong>User:</strong> {tokenClaims?.sub ?? "-"}
          </small>
          <small>
            <strong>Role:</strong> {tokenClaims?.role ?? "-"}
          </small>
          <button onClick={logout} type="button">
            Logout
          </button>
        </div>
      </aside>

      <main className="app-content">
        <header className="topbar">
          <div>
            <h2>{activeView === "clients" ? "Clients" : activeView === "agents" ? "Agent Builder" : "Operations"}</h2>
            <p>{activeView === "clients" ? "Tenant CRM and onboarding" : activeView === "agents" ? "Guided setup and versioning" : "Live KPIs and call timeline"}</p>
          </div>

          <div className="topbar-actions">
            <label>
              Active tenant
              <select value={tenantId} onChange={(event) => selectTenant(event.target.value)}>
                {tenantOptions.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.name} ({tenant.id.slice(0, 8)}...)
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy} onClick={() => void loadTenants()} type="button">
              Refresh Tenants
            </button>
          </div>
        </header>

        <section className="status-strip">
          <span>
            Session: <strong>{token ? "Active" : "Missing"}</strong>
          </span>
          <span>
            Tenant: <strong>{tenantId}</strong>
          </span>
          <span>
            Status: <strong>{status}</strong>
          </span>
          <span>{busy ? "Working..." : "Idle"}</span>
        </section>

        {activeView === "clients" ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <h3>Tenant CRM</h3>
                <small>Search, select, and inspect client accounts.</small>
              </div>
              <div className="form-grid">
                <label>
                  Search
                  <input
                    value={tenantSearch}
                    onChange={(event) => setTenantSearch(event.target.value)}
                    placeholder="name, id, plan"
                  />
                </label>
                <button disabled={busy} onClick={() => void loadTenantSnapshot()} type="button">
                  Refresh Snapshot
                </button>
                <button disabled={busy} onClick={() => void loadAgents()} type="button">
                  Load Tenant Agents
                </button>
                <button disabled={busy} onClick={() => void loadPhoneNumbers()} type="button">
                  Load Phone Numbers
                </button>
              </div>

              <div className="split two-col">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Tenant</th>
                        <th>Plan</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTenants.map((tenant) => {
                        const snapshot = tenantSnapshots[tenant.id];
                        return (
                          <tr key={tenant.id} className={tenant.id === tenantId ? "row-active" : ""}>
                            <td>
                              <strong>{tenant.name}</strong>
                              <small>{tenant.id}</small>
                              {snapshot ? <small>Calls(200): {snapshot.calls}</small> : null}
                            </td>
                            <td>{tenant.plan}</td>
                            <td>{tenant.status}</td>
                            <td>{formatDateTime(tenant.created_at)}</td>
                            <td>
                              <button
                                disabled={busy}
                                onClick={() => {
                                  selectTenant(tenant.id);
                                  void loadTenantSnapshot(tenant.id);
                                }}
                                type="button"
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="detail-card">
                  <h4>{activeTenant?.name ?? "No tenant selected"}</h4>
                  {activeTenant ? (
                    <div className="metric-grid">
                      <div>
                        <small>Plan</small>
                        <strong>{activeTenant.plan}</strong>
                      </div>
                      <div>
                        <small>Status</small>
                        <strong>{activeTenant.status}</strong>
                      </div>
                      <div>
                        <small>Calls sample</small>
                        <strong>{activeTenantSnapshot?.calls ?? "-"}</strong>
                      </div>
                      <div>
                        <small>Resolved sample</small>
                        <strong>{activeTenantSnapshot?.resolvedCalls ?? "-"}</strong>
                      </div>
                      <div>
                        <small>Handoff sample</small>
                        <strong>{activeTenantSnapshot?.handoffCalls ?? "-"}</strong>
                      </div>
                      <div>
                        <small>Active sample</small>
                        <strong>{activeTenantSnapshot?.activeCalls ?? "-"}</strong>
                      </div>
                    </div>
                  ) : (
                    <p>Select a tenant to see details.</p>
                  )}

                  <form className="form-grid soft" onSubmit={createTenant}>
                    <label>
                      New tenant name
                      <input
                        value={newTenantName}
                        onChange={(event) => setNewTenantName(event.target.value)}
                        placeholder="Acme Dental"
                      />
                    </label>
                    <button disabled={busy} type="submit">
                      Create Tenant
                    </button>
                  </form>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {activeView === "agents" ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <h3>Agent Wizard</h3>
                <small>Simple 3-step flow to create and publish an agent.</small>
              </div>

              <div className="stepper">
                <button className={wizardStep === 1 ? "active" : ""} onClick={() => setWizardStep(1)} type="button">
                  1. Identity
                </button>
                <button className={wizardStep === 2 ? "active" : ""} onClick={() => setWizardStep(2)} type="button">
                  2. Voice + Model
                </button>
                <button className={wizardStep === 3 ? "active" : ""} onClick={() => setWizardStep(3)} type="button">
                  3. Prompt + Publish
                </button>
              </div>

              <form className="wizard" onSubmit={createAgentWorkflow}>
                {wizardStep === 1 ? (
                  <div className="form-grid">
                    <label>
                      Tenant
                      <select value={tenantId} onChange={(event) => selectTenant(event.target.value)}>
                        {tenantOptions.map((tenant) => (
                          <option key={tenant.id} value={tenant.id}>
                            {tenant.name} ({tenant.id.slice(0, 8)}...)
                          </option>
                        ))}
                      </select>
                    </label>
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
                  </div>
                ) : null}

                {wizardStep === 2 ? (
                  <div className="form-grid">
                    <label>
                      LLM model
                      <input value={newAgentLlmModel} onChange={(event) => setNewAgentLlmModel(event.target.value)} />
                    </label>
                    <label>
                      STT provider
                      <input value={newAgentSttProvider} onChange={(event) => setNewAgentSttProvider(event.target.value)} />
                    </label>
                    <label>
                      TTS provider
                      <input value={newAgentTtsProvider} onChange={(event) => setNewAgentTtsProvider(event.target.value)} />
                    </label>
                    <label>
                      Voice ID (optional)
                      <input
                        value={newAgentVoiceId}
                        onChange={(event) => setNewAgentVoiceId(event.target.value)}
                        placeholder="voice_123"
                      />
                    </label>
                    <label className="wide">
                      Initial greeting (optional)
                      <input
                        value={newAgentGreeting}
                        onChange={(event) => setNewAgentGreeting(event.target.value)}
                        placeholder="Hola, gracias por llamar a Pizzeria. ¿En que te ayudo hoy?"
                      />
                    </label>
                  </div>
                ) : null}

                {wizardStep === 3 ? (
                  <div className="form-grid">
                    <label>
                      Create first version
                      <select
                        value={wizardCreateVersion ? "yes" : "no"}
                        onChange={(event) => setWizardCreateVersion(event.target.value === "yes")}
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    <label>
                      Publish immediately
                      <select
                        value={wizardPublishNow ? "yes" : "no"}
                        onChange={(event) => setWizardPublishNow(event.target.value === "yes")}
                        disabled={!wizardCreateVersion}
                      >
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                    <label>
                      Temperature
                      <input
                        value={newVersionTemperature}
                        onChange={(event) => setNewVersionTemperature(event.target.value)}
                        placeholder="0.3"
                        disabled={!wizardCreateVersion}
                      />
                    </label>
                    <label className="wide">
                      System prompt
                      <input
                        value={newVersionPrompt}
                        onChange={(event) => setNewVersionPrompt(event.target.value)}
                        placeholder="Prompt para el agente"
                        disabled={!wizardCreateVersion}
                      />
                    </label>
                  </div>
                ) : null}

                <div className="wizard-actions">
                  <button disabled={busy || wizardStep === 1} onClick={() => setWizardStep((wizardStep - 1) as WizardStep)} type="button">
                    Back
                  </button>
                  <button
                    disabled={
                      busy ||
                      wizardStep === 3 ||
                      (wizardStep === 1 && (!isUuid(tenantId) || newAgentName.trim().length < 2)) ||
                      (wizardStep === 2 && !newAgentLlmModel.trim())
                    }
                    onClick={() => setWizardStep((wizardStep + 1) as WizardStep)}
                    type="button"
                  >
                    Next
                  </button>
                  <button disabled={busy || !wizardCanSubmit} type="submit">
                    Create Workflow
                  </button>
                  <button disabled={busy} onClick={() => void loadAgents()} type="button">
                    Reload Agents
                  </button>
                </div>
              </form>
            </section>

            <section className="split two-col">
              <div className="panel">
                <div className="panel-head">
                  <h3>Agents</h3>
                  <small>{agents.length} loaded</small>
                </div>
                <ul className="list">
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
                <div className="panel-head">
                  <h3>Versions</h3>
                  <small>{selectedAgent ? selectedAgent.name : "Select an agent"}</small>
                </div>

                {selectedAgent ? (
                  <>
                    <p>
                      El <strong>saludo inicial</strong> se reproduce al contestar. El <strong>system prompt</strong> vive en las versiones y
                      controla las respuestas despues de que el cliente habla.
                    </p>

                    <form className="form-grid soft" onSubmit={updateSelectedAgentSettings}>
                      <label className="wide">
                        Initial greeting
                        <input
                          value={editAgentGreeting}
                          onChange={(event) => setEditAgentGreeting(event.target.value)}
                          placeholder="Hola, gracias por llamar a Pizzeria. ¿En que te ayudo hoy?"
                        />
                      </label>
                      <label>
                        Voice ID (optional)
                        <input
                          value={editAgentVoiceId}
                          onChange={(event) => setEditAgentVoiceId(event.target.value)}
                          placeholder="voice_123"
                        />
                      </label>
                      <button disabled={busy} type="submit">
                        Save Agent Settings
                      </button>
                    </form>

                    <div className="versions-grid">
                      {agentVersions.map((version) => (
                        <article key={version.id} className="version-card">
                          <div className="row-inline">
                            <strong>v{version.version}</strong>
                            {version.published_at ? (
                              <span className="badge on">published</span>
                            ) : (
                              <button disabled={busy} onClick={() => void publishVersion(version.id)} type="button">
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
                  <p>Select an agent to view versions.</p>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h3>Phone Routing</h3>
                <small>Assign Twilio number to an agent for inbound calls.</small>
              </div>

              <div className="form-grid">
                <button disabled={busy} onClick={() => void loadPhoneNumbers()} type="button">
                  Load Phone Numbers
                </button>
                <button disabled={busy} onClick={() => void loadAgents()} type="button">
                  Load Agents
                </button>
              </div>

              <form className="form-grid soft" onSubmit={createPhoneNumber}>
                <label>
                  E.164 Number
                  <input value={newPhoneE164} onChange={(event) => setNewPhoneE164(event.target.value)} placeholder="+526612345678" />
                </label>
                <label>
                  Twilio SID
                  <input
                    value={newPhoneTwilioSid}
                    onChange={(event) => setNewPhoneTwilioSid(event.target.value)}
                    placeholder="PNxxxxxxxxxxxxxxxx"
                  />
                </label>
                <label>
                  Default Agent (optional)
                  <select value={newPhoneAgentId} onChange={(event) => setNewPhoneAgentId(event.target.value)}>
                    <option value="">Unassigned</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy} type="submit">
                  Add Phone Number
                </button>
              </form>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Number</th>
                      <th>Twilio SID</th>
                      <th>Status</th>
                      <th>Assigned Agent</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {phoneNumbers.map((phone) => (
                      <tr key={phone.id}>
                        <td>
                          <strong>{phone.e164}</strong>
                          <small>{phone.id}</small>
                        </td>
                        <td>{phone.twilio_sid}</td>
                        <td>{phone.status}</td>
                        <td>
                          <select
                            value={phoneAgentDrafts[phone.id] ?? ""}
                            onChange={(event) =>
                              setPhoneAgentDrafts((current) => ({
                                ...current,
                                [phone.id]: event.target.value
                              }))
                            }
                          >
                            <option value="">Unassigned</option>
                            {agents.map((agent) => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                          </select>
                          {phone.agent_name ? <small>Current: {phone.agent_name}</small> : null}
                        </td>
                        <td>
                          <button disabled={busy} onClick={() => void assignPhoneNumberAgent(phone.id)} type="button">
                            Save
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}

        {activeView === "operations" ? (
          <>
            <section className="panel">
              <div className="panel-head">
                <h3>Filters</h3>
                <small>Controls for KPI and call timeline.</small>
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
                <button disabled={busy} onClick={() => void loadOperations()} type="button">
                  Refresh Operations
                </button>
              </div>
            </section>

            <section className="kpi-grid">
              <article className="kpi-card">
                <small>Total Calls</small>
                <strong>{totals.totalCalls}</strong>
              </article>
              <article className="kpi-card">
                <small>Avg Duration</small>
                <strong>{formatSeconds(totals.avgDurationSec)}</strong>
              </article>
              <article className="kpi-card">
                <small>Resolution Rate</small>
                <strong>{totals.resolutionRate.toFixed(2)}%</strong>
              </article>
              <article className="kpi-card">
                <small>Handoff Rate</small>
                <strong>{totals.handoffRate.toFixed(2)}%</strong>
              </article>
              <article className="kpi-card">
                <small>Total Cost</small>
                <strong>{usdFormatter.format(totals.totalCost)}</strong>
              </article>
              <article className="kpi-card">
                <small>Active Calls</small>
                <strong>{totals.activeCalls}</strong>
              </article>
            </section>

            <section className="split two-col">
              <div className="panel">
                <div className="panel-head">
                  <h3>Calls</h3>
                  <small>{calls.length} loaded</small>
                </div>
                <ul className="list long">
                  {calls.map((call) => {
                    const isActive = !call.ended_at;
                    return (
                      <li key={call.id}>
                        <button
                          className={selectedCallId === call.id ? "active" : ""}
                          onClick={() => {
                            setSelectedCallId(call.id);
                            void loadCallEvents(call.id);
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
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>Timeline</h3>
                  {selectedCall ? (
                    <button disabled={busy} onClick={() => void loadCallEvents(selectedCall.id)} type="button">
                      Refresh
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
                        <p>No events loaded yet.</p>
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
                  <p>Select a call to inspect timeline events.</p>
                )}
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
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
