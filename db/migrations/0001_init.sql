create extension if not exists "pgcrypto";

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active',
  timezone text not null default 'UTC',
  plan text not null default 'starter',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  is_internal boolean not null default false,
  created_at timestamptz not null default now()
);

create table memberships (
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('internal_admin', 'internal_operator', 'client_viewer')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  status text not null default 'draft',
  language text not null default 'es',
  llm_model text not null default 'gpt-4o-mini',
  stt_provider text not null default 'deepgram',
  tts_provider text not null default 'rime',
  voice_id text,
  created_at timestamptz not null default now()
);

create table agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  version int not null,
  system_prompt text not null,
  temperature numeric(3,2) not null default 0.30,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

create table phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  twilio_sid text not null unique,
  e164 text not null unique,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table tenant_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  type text not null check (type in ('n8n_cloud')),
  base_url text not null,
  auth_type text not null check (auth_type in ('api_key', 'bearer')),
  encrypted_secret text not null,
  status text not null default 'active',
  last_test_at timestamptz,
  created_at timestamptz not null default now()
);

create table tools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text not null,
  input_schema_json jsonb not null,
  timeout_ms int not null default 5000,
  max_retries int not null default 1,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table tool_endpoints (
  id uuid primary key default gen_random_uuid(),
  tool_id uuid not null references tools(id) on delete cascade,
  integration_id uuid not null references tenant_integrations(id) on delete cascade,
  webhook_path text not null,
  method text not null default 'POST',
  headers_template jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table agent_tools (
  agent_version_id uuid not null references agent_versions(id) on delete cascade,
  tool_id uuid not null references tools(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (agent_version_id, tool_id)
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete restrict,
  phone_number_id uuid references phone_numbers(id) on delete set null,
  twilio_call_sid text not null unique,
  livekit_room text,
  outcome text,
  handoff_reason text,
  legal_hold boolean not null default false,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table utterances (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  speaker text not null check (speaker in ('caller', 'agent', 'system')),
  text text not null,
  start_ms int not null,
  end_ms int not null,
  confidence numeric(4,3),
  created_at timestamptz not null default now()
);

create table call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null,
  payload_json jsonb not null
);

create table recordings (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null unique references calls(id) on delete cascade,
  storage_url text not null,
  duration_sec int,
  redacted boolean not null default false,
  created_at timestamptz not null default now()
);

create table tool_executions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  tool_id uuid not null references tools(id) on delete restrict,
  request_json jsonb not null,
  response_json jsonb,
  status text not null check (status in ('success', 'error', 'timeout')),
  latency_ms int,
  error_code text,
  created_at timestamptz not null default now()
);

create table call_metrics (
  call_id uuid primary key references calls(id) on delete cascade,
  stt_ms int not null default 0,
  llm_ms int not null default 0,
  tts_ms int not null default 0,
  tool_ms_total int not null default 0,
  total_ms int not null default 0,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_usd numeric(12,6) not null default 0
);

create table daily_kpis (
  day date not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  calls int not null default 0,
  avg_duration_sec int not null default 0,
  resolution_rate numeric(5,2) not null default 0,
  handoff_rate numeric(5,2) not null default 0,
  total_cost_usd numeric(12,6) not null default 0,
  primary key (day, tenant_id, agent_id)
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text not null,
  reason text,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  status text not null check (status in ('running', 'success', 'error')),
  records_deleted int not null default 0,
  details_json jsonb not null default '{}'::jsonb
);

create index idx_calls_tenant_started on calls (tenant_id, started_at desc);
create index idx_utterances_call_start on utterances (call_id, start_ms);
create index idx_call_events_call_ts on call_events (call_id, ts);
create index idx_tool_exec_call_created on tool_executions (call_id, created_at);
create index idx_daily_kpis_tenant_day on daily_kpis (tenant_id, day);
