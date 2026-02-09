-- Expires pending runtime dispatches and purges old terminal rows.

update runtime_dispatches
set status = 'expired',
    agent_join_token = ''
where status = 'pending'
  and expires_at <= now();

delete from runtime_dispatches
where status in ('claimed', 'expired')
  and created_at < now() - interval '24 hours';
