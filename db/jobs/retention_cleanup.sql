-- Retention policy: remove sensitive call data older than 30 days,
-- except when the parent call has legal_hold = true.

with deletable_calls as (
  select id
  from calls
  where legal_hold = false
    and started_at < now() - interval '30 days'
)
delete from recordings r
using deletable_calls dc
where r.call_id = dc.id;

with deletable_calls as (
  select id
  from calls
  where legal_hold = false
    and started_at < now() - interval '30 days'
)
delete from utterances u
using deletable_calls dc
where u.call_id = dc.id;

with deletable_calls as (
  select id
  from calls
  where legal_hold = false
    and started_at < now() - interval '30 days'
)
delete from call_events e
using deletable_calls dc
where e.call_id = dc.id;
