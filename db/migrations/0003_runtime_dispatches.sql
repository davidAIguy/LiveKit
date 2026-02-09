create table if not exists runtime_dispatches (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  trace_id uuid not null,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  twilio_call_sid text not null,
  room text not null,
  agent_join_token text not null,
  status text not null check (status in ('pending', 'claimed', 'expired')) default 'pending',
  claimed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_runtime_dispatches_call_trace
on runtime_dispatches (call_id, trace_id);

create index if not exists idx_runtime_dispatches_pending
on runtime_dispatches (status, created_at)
where status = 'pending';
