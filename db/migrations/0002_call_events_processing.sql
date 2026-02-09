alter table call_events
add column if not exists processed_at timestamptz,
add column if not exists processing_attempts int not null default 0,
add column if not exists last_error text;

create index if not exists idx_call_events_runtime_queue
on call_events (type, processed_at, ts)
where type = 'runtime.handoff_requested';
