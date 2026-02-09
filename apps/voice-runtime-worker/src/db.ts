import pg from "pg";
import { env } from "./config.js";
import type { RuntimeEvent, RuntimeLaunchJob } from "./types.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20
});

async function claimEventsByType(type: string, limit: number): Promise<RuntimeEvent[]> {
  const result = await db.query(
    `with claimable as (
       select id
       from call_events
       where type = $1
         and processed_at is null
       order by ts asc
       limit $2
       for update skip locked
     )
     update call_events e
     set processing_attempts = e.processing_attempts + 1
     from claimable c
     where e.id = c.id
     returning e.id, e.call_id, e.type, e.payload_json, e.processing_attempts`,
    [type, limit]
  );

  return result.rows as RuntimeEvent[];
}

export async function claimRuntimeEvents(limit: number): Promise<RuntimeEvent[]> {
  return claimEventsByType("runtime.handoff_requested", limit);
}

export async function claimDispatchedEvents(limit: number): Promise<RuntimeEvent[]> {
  return claimEventsByType("runtime.handoff_dispatched", limit);
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await db.query(`update call_events set processed_at = now(), last_error = null where id = $1`, [eventId]);
}

export async function markEventFailed(eventId: string, message: string, finalize: boolean): Promise<void> {
  await db.query(
    `update call_events
     set last_error = $2,
         processed_at = case when $3 then now() else processed_at end
     where id = $1`,
    [eventId, message, finalize]
  );
}

export async function appendCallEvent(callId: string, type: string, payload: unknown): Promise<void> {
  await db.query(
    `insert into call_events (call_id, type, payload_json)
     values ($1, $2, $3::jsonb)`,
    [callId, type, JSON.stringify(payload)]
  );
}

export async function createRuntimeDispatch(input: {
  callId: string;
  traceId: string;
  tenantId: string;
  agentId: string;
  twilioCallSid: string;
  room: string;
  agentJoinToken: string;
  expiresInMinutes?: number;
}): Promise<{ id: string; expires_at: string }> {
  const expiresInMinutes = input.expiresInMinutes ?? 10;

  const result = await db.query(
    `insert into runtime_dispatches (
       call_id,
       trace_id,
       tenant_id,
       agent_id,
       twilio_call_sid,
       room,
       agent_join_token,
       expires_at
     )
     values ($1, $2::uuid, $3, $4, $5, $6, $7, now() + make_interval(mins => $8))
     on conflict (call_id, trace_id)
     do update set
       agent_join_token = excluded.agent_join_token,
       expires_at = excluded.expires_at,
       status = 'pending',
       claimed_at = null
     returning id, expires_at`,
    [
      input.callId,
      input.traceId,
      input.tenantId,
      input.agentId,
      input.twilioCallSid,
      input.room,
      input.agentJoinToken,
      expiresInMinutes
    ]
  );

  return result.rows[0] as { id: string; expires_at: string };
}

export async function createRuntimeLaunchJob(input: {
  callId: string;
  dispatchId: string;
  tenantId: string;
  agentId: string;
  traceId: string;
  room: string;
  twilioCallSid: string;
  livekitUrl: string;
  agentJoinToken: string;
}): Promise<{ id: string }> {
  const result = await db.query(
    `insert into runtime_launch_jobs (
       call_id,
       dispatch_id,
       tenant_id,
       agent_id,
       trace_id,
       room,
       twilio_call_sid,
       livekit_url,
       agent_join_token,
       status
     )
     values ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, 'pending')
     on conflict (dispatch_id)
     do update set
       livekit_url = excluded.livekit_url,
       agent_join_token = excluded.agent_join_token,
       status = 'pending',
       attempts = 0,
       last_error = null,
       processed_at = null
     returning id`,
    [
      input.callId,
      input.dispatchId,
      input.tenantId,
      input.agentId,
      input.traceId,
      input.room,
      input.twilioCallSid,
      input.livekitUrl,
      input.agentJoinToken
    ]
  );

  return result.rows[0] as { id: string };
}

export async function claimRuntimeLaunchJobs(limit: number, maxAttempts: number): Promise<RuntimeLaunchJob[]> {
  const result = await db.query(
    `with claimable as (
       select id
       from runtime_launch_jobs
       where status in ('pending', 'failed')
         and attempts < $2
       order by created_at asc
       limit $1
       for update skip locked
     )
     update runtime_launch_jobs j
     set status = 'processing',
         attempts = j.attempts + 1,
         last_error = null
     from claimable c
     where j.id = c.id
     returning
       j.id,
       j.call_id,
       j.dispatch_id,
       j.tenant_id,
       j.agent_id,
       j.trace_id,
       j.room,
       j.twilio_call_sid,
       j.livekit_url,
       j.agent_join_token,
       j.attempts`,
    [limit, maxAttempts]
  );

  return result.rows as RuntimeLaunchJob[];
}

export async function markRuntimeLaunchJobSucceeded(jobId: string): Promise<void> {
  await db.query(
    `update runtime_launch_jobs
     set status = 'succeeded',
         processed_at = now(),
         agent_join_token = ''
     where id = $1`,
    [jobId]
  );
}

export async function markRuntimeLaunchJobFailed(jobId: string, errorMessage: string): Promise<void> {
  await db.query(
    `update runtime_launch_jobs
     set status = 'failed',
         last_error = $2
     where id = $1`,
    [jobId, errorMessage]
  );
}

export async function projectEndedCallsFromEvents(limit: number): Promise<number> {
  const result = await db.query(
    `with candidate_calls as (
       select
         c.id as call_id,
         max(e.ts) filter (
           where e.type in (
             'runtime.twilio_media_stream_stopped',
             'runtime.twilio_media_stream_disconnected',
             'runtime.connector_session_closed'
           )
         ) as ended_at,
         bool_or(e.type = 'runtime.connector_agent_turn_generated') as had_agent_turn,
         bool_or(e.type = 'runtime.handoff_failed') as had_handoff_failure,
         bool_or(e.type = 'runtime.dispatch_claim_failed') as had_claim_failure,
         bool_or(e.type = 'runtime.agent_session_launch_failed') as had_launch_failure
       from calls c
       join call_events e on e.call_id = c.id
       where c.ended_at is null
         and e.type in (
           'runtime.twilio_media_stream_stopped',
           'runtime.twilio_media_stream_disconnected',
           'runtime.connector_session_closed',
           'runtime.connector_agent_turn_generated',
           'runtime.handoff_failed',
           'runtime.dispatch_claim_failed',
           'runtime.agent_session_launch_failed'
         )
       group by c.id
       having max(e.ts) filter (
         where e.type in (
           'runtime.twilio_media_stream_stopped',
           'runtime.twilio_media_stream_disconnected',
           'runtime.connector_session_closed'
         )
       ) is not null
       order by ended_at asc
       limit $1
     ),
     updated as (
       update calls c
       set
         ended_at = candidate_calls.ended_at,
         outcome = case
           when c.outcome is not null then c.outcome
           when
             candidate_calls.had_handoff_failure
             or candidate_calls.had_claim_failure
             or candidate_calls.had_launch_failure then 'handoff'
           when candidate_calls.had_agent_turn then 'resolved'
           else c.outcome
         end,
         handoff_reason = case
           when c.handoff_reason is not null then c.handoff_reason
           when candidate_calls.had_handoff_failure then 'runtime_handoff_failed'
           when candidate_calls.had_claim_failure then 'runtime_dispatch_claim_failed'
           when candidate_calls.had_launch_failure then 'runtime_agent_launch_failed'
           else c.handoff_reason
         end
       from candidate_calls
       where c.id = candidate_calls.call_id
       returning c.id
     )
     select count(*)::int as updated_count from updated`,
    [limit]
  );

  return Number((result.rows[0] as { updated_count: number }).updated_count);
}

export async function refreshCallMetrics(lookbackDays: number): Promise<number> {
  const result = await db.query(
    `with aggregated as (
       select
         c.id as call_id,
         coalesce(sum(t.latency_ms), 0)::int as tool_ms_total,
         case
           when c.ended_at is not null and c.ended_at >= c.started_at
             then floor(extract(epoch from (c.ended_at - c.started_at)) * 1000)::int
           else 0
         end as total_ms
       from calls c
       left join tool_executions t on t.call_id = c.id
       where c.started_at >= now() - make_interval(days => $1)
       group by c.id, c.started_at, c.ended_at
     ),
     upserted as (
       insert into call_metrics (call_id, tool_ms_total, total_ms)
       select call_id, tool_ms_total, total_ms
       from aggregated
       on conflict (call_id)
       do update set
         tool_ms_total = excluded.tool_ms_total,
         total_ms = excluded.total_ms
       returning 1
     )
     select count(*)::int as upserted_count from upserted`,
    [lookbackDays]
  );

  return Number((result.rows[0] as { upserted_count: number }).upserted_count);
}

export async function refreshDailyKpis(lookbackDays: number): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("begin");

    const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    await client.query(`delete from daily_kpis where day >= $1::date`, [cutoffDate]);

    const inserted = await client.query(
      `insert into daily_kpis (
         day,
         tenant_id,
         agent_id,
         calls,
         avg_duration_sec,
         resolution_rate,
         handoff_rate,
         total_cost_usd
       )
       select
         date_trunc('day', c.started_at at time zone 'UTC')::date as day,
         c.tenant_id,
         c.agent_id,
         count(*)::int as calls,
         coalesce(
           round(
             avg(
               case
                 when c.ended_at is not null and c.ended_at >= c.started_at
                   then extract(epoch from (c.ended_at - c.started_at))
                 else null
               end
             )
           )::int,
           0
         ) as avg_duration_sec,
         coalesce(
           round((count(*) filter (where c.outcome = 'resolved'))::numeric * 100 / nullif(count(*), 0), 2),
           0
         )::numeric(5,2) as resolution_rate,
         coalesce(
           round(
             (
               count(*) filter (where c.outcome = 'handoff' or c.handoff_reason is not null)
             )::numeric * 100 / nullif(count(*), 0),
             2
           ),
           0
         )::numeric(5,2) as handoff_rate,
         coalesce(sum(cm.cost_usd), 0)::numeric(12,6) as total_cost_usd
       from calls c
       left join call_metrics cm on cm.call_id = c.id
       where c.started_at >= $1::timestamptz
       group by 1, 2, 3`,
      [cutoffDate]
    );

    await client.query("commit");
    return inserted.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export interface RetentionCleanupResult {
  jobId: string;
  recordsDeleted: number;
  eligibleCalls: number;
  recordingsDeleted: number;
  utterancesDeleted: number;
  eventsDeleted: number;
}

export async function runRetentionCleanup(retentionDays: number): Promise<RetentionCleanupResult> {
  const job = await db.query(
    `insert into deletion_jobs (status, details_json)
     values ('running', $1::jsonb)
     returning id`,
    [JSON.stringify({ retention_days: retentionDays })]
  );

  const jobId = (job.rows[0] as { id: string }).id;

  try {
    const result = await db.query(
      `with deletable_calls as (
         select id
         from calls
         where legal_hold = false
           and started_at < now() - make_interval(days => $1)
       ),
       deleted_recordings as (
         delete from recordings r
         using deletable_calls dc
         where r.call_id = dc.id
         returning r.id
       ),
       deleted_utterances as (
         delete from utterances u
         using deletable_calls dc
         where u.call_id = dc.id
         returning u.id
       ),
       deleted_events as (
         delete from call_events e
         using deletable_calls dc
         where e.call_id = dc.id
         returning e.id
       )
       select
         (select count(*)::int from deletable_calls) as eligible_calls,
         (select count(*)::int from deleted_recordings) as recordings_deleted,
         (select count(*)::int from deleted_utterances) as utterances_deleted,
         (select count(*)::int from deleted_events) as events_deleted`,
      [retentionDays]
    );

    const counts = result.rows[0] as {
      eligible_calls: number;
      recordings_deleted: number;
      utterances_deleted: number;
      events_deleted: number;
    };

    const recordsDeleted = counts.recordings_deleted + counts.utterances_deleted + counts.events_deleted;

    await db.query(
      `update deletion_jobs
       set status = 'success',
           completed_at = now(),
           records_deleted = $2,
           details_json = $3::jsonb
       where id = $1`,
      [
        jobId,
        recordsDeleted,
        JSON.stringify({
          retention_days: retentionDays,
          eligible_calls: counts.eligible_calls,
          recordings_deleted: counts.recordings_deleted,
          utterances_deleted: counts.utterances_deleted,
          events_deleted: counts.events_deleted
        })
      ]
    );

    return {
      jobId,
      recordsDeleted,
      eligibleCalls: counts.eligible_calls,
      recordingsDeleted: counts.recordings_deleted,
      utterancesDeleted: counts.utterances_deleted,
      eventsDeleted: counts.events_deleted
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "retention_cleanup_error";
    await db.query(
      `update deletion_jobs
       set status = 'error',
           completed_at = now(),
           details_json = $2::jsonb
       where id = $1`,
      [jobId, JSON.stringify({ retention_days: retentionDays, error: message })]
    );
    throw error;
  }
}
