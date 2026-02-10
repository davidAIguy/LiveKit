import pg from "pg";
import { env } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20
});

export async function healthcheckDb(): Promise<void> {
  await db.query("select 1");
}

export async function appendCallEvent(callId: string, type: string, payload: unknown): Promise<void> {
  await db.query(
    `insert into call_events (call_id, type, payload_json)
     values ($1, $2, $3::jsonb)`,
    [callId, type, JSON.stringify(payload)]
  );
}

export async function findCallContext(callId: string): Promise<{
  call_id: string;
  tenant_id: string;
  agent_id: string;
  llm_model: string;
  stt_provider: string;
  tts_provider: string;
  system_prompt: string | null;
  greeting_text: string | null;
} | null> {
  const result = await db.query(
    `select
       c.id as call_id,
       c.tenant_id,
       c.agent_id,
       a.llm_model,
       a.stt_provider,
       a.tts_provider,
       a.greeting_text,
       av.system_prompt
     from calls c
     join agents a on a.id = c.agent_id
     left join agent_versions av on av.agent_id = a.id and av.published_at is not null
     where c.id = $1
     order by av.published_at desc nulls last
     limit 1`,
    [callId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as {
    call_id: string;
    tenant_id: string;
    agent_id: string;
    llm_model: string;
    stt_provider: string;
    tts_provider: string;
    system_prompt: string | null;
    greeting_text: string | null;
  };
}

export async function getNextUtteranceStart(callId: string): Promise<number> {
  const result = await db.query(
    `select coalesce(max(end_ms), 0) as max_end_ms
     from utterances
     where call_id = $1`,
    [callId]
  );
  return Number(result.rows[0].max_end_ms) + 100;
}

export async function insertUtterance(input: {
  callId: string;
  speaker: "caller" | "agent" | "system";
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
}): Promise<void> {
  await db.query(
    `insert into utterances (call_id, speaker, text, start_ms, end_ms, confidence)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.callId, input.speaker, input.text, input.startMs, input.endMs, input.confidence ?? null]
  );
}

export async function findCallByTwilioSid(twilioCallSid: string): Promise<{
  call_id: string;
  trace_id: string;
  tenant_id: string;
} | null> {
  const result = await db.query(
    `select
       c.id as call_id,
       c.tenant_id,
       coalesce(
         (
           select (ev.payload_json->>'trace_id')
           from call_events ev
           where ev.call_id = c.id
             and (ev.payload_json->>'trace_id') is not null
           order by ev.ts desc
           limit 1
         ),
         '00000000-0000-0000-0000-000000000000'
       ) as trace_id
     from calls c
     where c.twilio_call_sid = $1
     limit 1`,
    [twilioCallSid]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as {
    call_id: string;
    trace_id: string;
    tenant_id: string;
  };
}
