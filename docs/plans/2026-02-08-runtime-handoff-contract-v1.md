# Runtime Handoff Contract v1

Event type: `runtime.handoff_requested`

Stored in `call_events.payload_json`.

```json
{
  "version": "v1",
  "trace_id": "uuid",
  "source": "twilio_inbound_webhook",
  "tenant_id": "uuid",
  "agent_id": "uuid",
  "twilio_call_sid": "string",
  "room": "string",
  "from": "string",
  "to": "string"
}
```

## Producer

- `POST /twilio/webhook/inbound` in control-plane API.

## Consumer

- `apps/voice-runtime-worker` polling `call_events` queue fields (`processed_at`, `processing_attempts`).

## Result events

- `runtime.handoff_dispatched`
- `runtime.handoff_failed`
- `runtime.handoff_invalid_payload`

`runtime.handoff_dispatched` payload shape:

```json
{
  "event_id": "uuid",
  "trace_id": "uuid",
  "tenant_id": "uuid",
  "agent_id": "uuid",
  "room": "string",
  "livekit_url": "https://...",
  "dispatch_id": "uuid",
  "dispatch_expires_at": "timestamp"
}
```

Join tokens are stored in `runtime_dispatches.agent_join_token` and are not written into `call_events`.

## Secure claim flow

1. Worker stores token in `runtime_dispatches` with status `pending` and expiry.
2. Runtime agent client calls `POST /internal/runtime/dispatches/claim` with `dispatch_id`.
3. API atomically marks row as `claimed`, returns token once, and clears token in storage.
4. Cleanup job `db/jobs/expire_runtime_dispatches.sql` expires stale pending rows.

## Claim result events

- `runtime.dispatch_claimed`
- `runtime.dispatch_claim_failed`
- `runtime.agent_session_bootstrap_ready`

## Agent launch events

- `runtime.agent_session_launch_succeeded`
- `runtime.agent_session_launch_failed`

`runtime.agent_session_bootstrap_ready` now includes `launch_job_id` and launch is handled by `runtime_launch_jobs` queue.

Launch jobs are sent by `voice-runtime-worker` to `POST /runtime/agent-sessions/launch` on the agent-runner service.
