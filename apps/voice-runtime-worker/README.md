# Voice Runtime Worker

Consumes `runtime.handoff_requested` events from `call_events`, creates or confirms LiveKit rooms, and appends dispatch status events.

Also runs ingestion, KPI rollup, and optional retention cleanup loops.

## Setup

1. Copy `.env.example` to `.env`.
2. Ensure DB migrations `0001_init.sql`, `0002_call_events_processing.sql`, `0003_runtime_dispatches.sql`, `0004_call_events_dispatch_queue.sql`, and `0005_runtime_launch_jobs.sql` are applied.
3. Install dependencies: `npm install`.
4. Start worker: `npm run dev`.

## Behavior

- Claims unprocessed runtime events in batches.
- Validates payload contract (`version`, `trace_id`, `tenant_id`, `agent_id`, `room`, etc.).
- Creates LiveKit room if missing.
- Generates agent join token and stores it in `runtime_dispatches` (secure dispatch record).
- Claims runtime dispatches through control-plane API using service JWT (if `CLAIMER_ENABLED=true`).
- Enqueues `runtime_launch_jobs` with secure join token handoff.
- Calls external agent runner webhook to start real agent sessions (if `LAUNCHER_ENABLED=true`).
- Appends result events:
  - `runtime.handoff_dispatched`
  - `runtime.handoff_failed`
  - `runtime.handoff_invalid_payload`
  - `runtime.dispatch_claimed`
  - `runtime.dispatch_claim_failed`
  - `runtime.agent_session_bootstrap_ready`
  - `runtime.agent_session_launch_succeeded`
  - `runtime.agent_session_launch_failed`
- Persists token in `runtime_dispatches` for secure one-time claim from control-plane API.
- Projects end-of-call lifecycle from runtime events into `calls` (`ended_at`, `outcome`, `handoff_reason`).
- Upserts `call_metrics` from call duration and tool execution latency.
- Refreshes `daily_kpis` on a rolling lookback window.
- Optionally executes retention cleanup and records each run in `deletion_jobs`.

## Notes

- `runtime.handoff_dispatched` includes `dispatch_id` and `dispatch_expires_at`, not raw join tokens.
- The agent process should consume `runtime_dispatches` through a secure claim channel.
- Schedule `db/jobs/expire_runtime_dispatches.sql` to expire and purge stale dispatch rows.
- Claim loop requires `CONTROL_PLANE_BASE_URL` and `CONTROL_PLANE_JWT_SECRET`.
- Launcher loop requires `AGENT_LAUNCHER_URL`.
- Recommended launcher target: `http://localhost:4100/runtime/agent-sessions/launch` (agent-runner service).
- Set `LIVEKIT_MOCK_MODE=true` for local pipeline tests without a real LiveKit server.
- Set `RETENTION_CLEANUP_ENABLED=true` only in environments where automated deletion is expected.

## New runtime knobs

- `INGESTION_ENABLED`, `INGESTION_POLL_INTERVAL_MS`, `INGESTION_BATCH_SIZE`
- `METRICS_LOOKBACK_DAYS`
- `KPI_ROLLUP_ENABLED`, `KPI_ROLLUP_INTERVAL_MS`, `KPI_LOOKBACK_DAYS`
- `RETENTION_CLEANUP_ENABLED`, `RETENTION_CLEANUP_INTERVAL_MS`, `RETENTION_DAYS`
