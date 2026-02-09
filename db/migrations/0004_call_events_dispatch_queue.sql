create index if not exists idx_call_events_dispatch_queue
on call_events (type, processed_at, ts)
where type = 'runtime.handoff_dispatched';
