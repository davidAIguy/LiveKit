import { env } from "./config.js";
import {
  appendCallEvent,
  claimRuntimeEvents,
  createRuntimeDispatch,
  markEventFailed,
  markEventProcessed
} from "./db.js";
import { ensureLiveKitRoom, prepareAgentJoinToken } from "./services/livekit.js";
import { RuntimeHandoffPayloadSchema } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processSingleEvent(event: {
  id: string;
  call_id: string;
  payload_json: unknown;
  processing_attempts: number;
}): Promise<void> {
  const parsed = RuntimeHandoffPayloadSchema.safeParse(event.payload_json);
  if (!parsed.success) {
    await appendCallEvent(event.call_id, "runtime.handoff_invalid_payload", {
      event_id: event.id,
      issues: parsed.error.issues
    });
    await markEventFailed(event.id, "invalid_payload", true);
    return;
  }

  const payload = parsed.data;

  try {
    await ensureLiveKitRoom(payload.room);
    const joinToken = await prepareAgentJoinToken(payload);
    const dispatch = await createRuntimeDispatch({
      callId: event.call_id,
      traceId: payload.trace_id,
      tenantId: payload.tenant_id,
      agentId: payload.agent_id,
      twilioCallSid: payload.twilio_call_sid,
      room: payload.room,
      agentJoinToken: joinToken,
      expiresInMinutes: 10
    });

    await appendCallEvent(event.call_id, "runtime.handoff_dispatched", {
      event_id: event.id,
      trace_id: payload.trace_id,
      tenant_id: payload.tenant_id,
      agent_id: payload.agent_id,
      room: payload.room,
      livekit_url: env.LIVEKIT_URL,
      dispatch_id: dispatch.id,
      dispatch_expires_at: dispatch.expires_at
    });

    await markEventProcessed(event.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_runtime_dispatch_error";
    const shouldFinalize = event.processing_attempts >= env.WORKER_MAX_ATTEMPTS;

    await appendCallEvent(event.call_id, "runtime.handoff_failed", {
      event_id: event.id,
      trace_id: payload.trace_id,
      attempts: event.processing_attempts,
      will_retry: !shouldFinalize,
      error: message
    });

    await markEventFailed(event.id, message, shouldFinalize);
  }
}

export async function runWorkerLoop(): Promise<void> {
  while (true) {
    const events = await claimRuntimeEvents(env.WORKER_BATCH_SIZE);

    if (events.length === 0) {
      await sleep(env.WORKER_POLL_INTERVAL_MS);
      continue;
    }

    for (const event of events) {
      await processSingleEvent(event);
    }
  }
}
