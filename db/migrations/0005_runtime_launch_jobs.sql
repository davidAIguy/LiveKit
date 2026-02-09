create table if not exists runtime_launch_jobs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  dispatch_id uuid not null references runtime_dispatches(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  trace_id uuid not null,
  room text not null,
  twilio_call_sid text not null,
  livekit_url text not null,
  agent_join_token text not null,
  status text not null check (status in ('pending', 'processing', 'succeeded', 'failed')) default 'pending',
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create unique index if not exists uq_runtime_launch_jobs_dispatch
on runtime_launch_jobs (dispatch_id);

create index if not exists idx_runtime_launch_jobs_queue
on runtime_launch_jobs (status, attempts, created_at)
where status in ('pending', 'failed');
