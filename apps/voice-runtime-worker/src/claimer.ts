import { env } from "./config.js";
import {
  appendCallEvent,
  claimDispatchedEvents,
  createRuntimeLaunchJob,
  markEventFailed,
  markEventProcessed
} from "./db.js";
import { claimRuntimeDispatch } from "./services/control-plane.js";
import { RuntimeHandoffDispatchedPayloadSchema } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processDispatchedEvent(event: {
  id: string;
  call_id: string;
  payload_json: unknown;
  processing_attempts: number;
}): Promise<void> {
  const parsed = RuntimeHandoffDispatchedPayloadSchema.safeParse(event.payload_json);
  if (!parsed.success) {
    await appendCallEvent(event.call_id, "runtime.claimer_invalid_payload", {
      event_id: event.id,
      issues: parsed.error.issues
    });
    await markEventFailed(event.id, "invalid_dispatched_payload", true);
    return;
  }

  const payload = parsed.data;

  try {
    const claimed = await claimRuntimeDispatch({
      dispatchId: payload.dispatch_id,
      tenantId: payload.tenant_id
    });

    const launchJob = await createRuntimeLaunchJob({
      callId: claimed.call_id,
      dispatchId: claimed.dispatch_id,
      tenantId: claimed.tenant_id,
      agentId: claimed.agent_id,
      traceId: claimed.trace_id,
      room: claimed.room,
      twilioCallSid: claimed.twilio_call_sid,
      livekitUrl: payload.livekit_url,
      agentJoinToken: claimed.agent_join_token
    });

    await appendCallEvent(event.call_id, "runtime.dispatch_claimed", {
      event_id: event.id,
      dispatch_id: claimed.dispatch_id,
      trace_id: claimed.trace_id,
      room: claimed.room,
      tenant_id: claimed.tenant_id,
      agent_id: claimed.agent_id,
      launch_job_id: launchJob.id
    });

    await appendCallEvent(event.call_id, "runtime.agent_session_bootstrap_ready", {
      event_id: event.id,
      dispatch_id: claimed.dispatch_id,
      launch_job_id: launchJob.id,
      trace_id: claimed.trace_id,
      room: claimed.room,
      livekit_url: env.LIVEKIT_URL
    });

    await markEventProcessed(event.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "dispatch_claim_error";
    const shouldFinalize = event.processing_attempts >= env.WORKER_MAX_ATTEMPTS;

    await appendCallEvent(event.call_id, "runtime.dispatch_claim_failed", {
      event_id: event.id,
      dispatch_id: payload.dispatch_id,
      trace_id: payload.trace_id,
      attempts: event.processing_attempts,
      will_retry: !shouldFinalize,
      error: message
    });

    await markEventFailed(event.id, message, shouldFinalize);
  }
}

export async function runDispatchClaimerLoop(): Promise<void> {
  while (true) {
    const events = await claimDispatchedEvents(env.WORKER_BATCH_SIZE);
    if (events.length === 0) {
      await sleep(env.CLAIMER_POLL_INTERVAL_MS);
      continue;
    }

    for (const event of events) {
      await processDispatchedEvent(event);
    }
  }
}
