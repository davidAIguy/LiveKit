# Local First and Railway Deploy Playbook

## Recommendation

Start local first, then deploy to Railway.

Reason:

- Local tests let you verify event flow and auth wiring before cloud debugging.
- Railway deployment is faster once env contracts are already validated.
- Provider webhooks (Twilio) and cloud networking add complexity you can avoid at first.

## Local bring-up order

1. Apply DB migrations in order: `0001` -> `0005`.
2. Start `control-plane-api` (`apps/control-plane-api`).
3. Start `agent-connector` (`apps/agent-connector`) in stub mode.
4. Start `agent-runner` (`apps/agent-runner`) pointing to connector.
5. Start `voice-runtime-worker` (`apps/voice-runtime-worker`) with claimer + launcher enabled.
6. Start `ops-debug-web` (`apps/ops-debug-web`) to inspect calls and timelines.

Expected pipeline:

`twilio webhook -> runtime.handoff_requested -> runtime.handoff_dispatched -> dispatch claim -> runtime_launch_job -> agent-runner launch -> connector stub accepted`

For local conversational simulation, send:

`POST /runtime/sessions/:callId/user-turn` on `agent-connector`.

## Railway deployment model (monorepo)

Based on Railway monorepo docs, create one Railway service per app and set **Root Directory** to:

- `/apps/control-plane-api`
- `/apps/voice-runtime-worker`
- `/apps/agent-runner`
- `/apps/agent-connector`
- `/apps/ops-debug-web` (optional debug UI service)

Each directory includes its own `railway.toml`.

## Minimum environment variables by service

### control-plane-api

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_ISSUER`
- `JWT_AUDIENCE`
- `ENCRYPTION_KEY`
- `TWILIO_VALIDATE_SIGNATURE`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WEBHOOK_BASE_URL`
- `DEV_BOOTSTRAP_KEY` (non-prod only)

### voice-runtime-worker

- `DATABASE_URL`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `CLAIMER_ENABLED=true`
- `CONTROL_PLANE_BASE_URL`
- `CONTROL_PLANE_JWT_SECRET`
- `CONTROL_PLANE_JWT_ISSUER`
- `CONTROL_PLANE_JWT_AUDIENCE`
- `LAUNCHER_ENABLED=true`
- `AGENT_LAUNCHER_URL` (agent-runner public URL)
- `AGENT_LAUNCHER_AUTH_TOKEN`

### agent-runner

- `LIVEKIT_API_SECRET`
- `RUNNER_AUTH_TOKEN`
- `AGENT_CONNECTOR_URL` (agent-connector public URL)
- `AGENT_CONNECTOR_AUTH_TOKEN`

### agent-connector

- `CONNECTOR_AUTH_TOKEN`

## Cross-service token alignment

- `voice-runtime-worker.AGENT_LAUNCHER_AUTH_TOKEN` must match `agent-runner.RUNNER_AUTH_TOKEN`.
- `agent-runner.AGENT_CONNECTOR_AUTH_TOKEN` must match `agent-connector.CONNECTOR_AUTH_TOKEN`.
- `voice-runtime-worker` JWT issuer/audience/secret must match `control-plane-api` JWT verifier settings.

## Railway rollout order

1. Provision Postgres in Railway.
2. Deploy `control-plane-api` and run migrations.
3. Deploy `agent-connector`.
4. Deploy `agent-runner`.
5. Deploy `voice-runtime-worker`.
6. Run synthetic call tests, then connect Twilio webhook URL.

## First cloud test checklist

- `GET /health` green on API services.
- Twilio webhook signature accepted in `control-plane-api` logs.
- `runtime.handoff_dispatched` and `runtime.dispatch_claimed` events appear.
- `runtime.agent_session_launch_succeeded` appears.
- Connector receives launch payload in logs.
