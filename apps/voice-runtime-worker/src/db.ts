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
