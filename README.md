# Voice Agent Ops Platform (MVP)

This repository contains the initial foundation for a multi-tenant AI voice platform operated by an internal team.

## Product model

- Internal team creates and manages agents.
- Client users only access a read-only metrics portal.
- Runtime uses Twilio + LiveKit + Deepgram + OpenAI + Rime.
- Automation runs through tenant-specific n8n Cloud integrations.
- Sensitive call data retention is 30 days, with legal-hold exceptions.

## Current repository layout

- `docs/plans/`: product and technical planning docs.
- `db/migrations/`: SQL schema migrations.
- `apps/control-plane-api/`: internal and client-facing API service.
- `apps/voice-runtime-worker/`: runtime handoff consumer and LiveKit bootstrap worker.
- `apps/agent-runner/`: receives launch requests and forwards them to agent connector runtime.
- `apps/agent-connector/`: connector stub endpoint for validated launch payloads.
- `apps/ops-debug-web/`: local/staging web interface for calls and runtime timeline inspection.

## Next implementation steps

1. Replace connector stub with real LiveKit participant bot implementation.
2. Add ingestion/analytics/retention workers.
3. Build Ops Console and Client Portal web apps.

## Security baseline

- Enforce tenant isolation in all data access paths.
- Encrypt integration secrets at rest.
- Validate inbound webhook signatures.
- Audit all sensitive internal actions.
- Use one-time runtime dispatch claim and scheduled dispatch expiry cleanup.

## Local quickstart

1. Start Postgres: `docker compose -f docker-compose.local.yml up -d`
2. Apply migrations: `./scripts/run-local-migrations.sh`
3. Start services in separate terminals:
   - `cd apps/control-plane-api && npm run dev`
   - `cd apps/agent-connector && npm run dev`
   - `cd apps/agent-runner && npm run dev`
   - `cd apps/voice-runtime-worker && npm run dev`
   - `cd apps/ops-debug-web && npm run dev`
4. Run baseline smoke test: `./scripts/local-smoke-test.sh`
5. Run automation e2e smoke test (LLM auto tool call): `./scripts/automation-e2e-smoke-test.sh`
6. Run Twilio media bridge smoke test: `./scripts/twilio-media-bridge-smoke-test.sh`
   - Require outbound TTS media: `REQUIRE_TTS_OUTBOUND=true ./scripts/twilio-media-bridge-smoke-test.sh`
   - Probe vendor TTS contract: `./scripts/tts-vendor-probe.sh rime` (or `remi`)
7. Use debug UI at `http://localhost:4300` and send simulated user turns via connector.

## Demo automation tools

- Provision realistic demo tools (customer lookup, order status, support ticket):
  - `./scripts/provision-demo-automation-tools.sh`
- Issue a dedicated gateway token for `agent-connector`:
  - `./scripts/issue-automation-gateway-token.sh`
- These tools point to local mock n8n-compatible routes exposed by `agent-connector` under `/mock-n8n/*`.
- After provisioning, test with a natural-language turn in connector (no `/tool` prefix required when auto tool-calling is enabled).

## Twilio media bridge (work in progress)

- `control-plane-api` can return `<Connect><Stream>` TwiML when `TWILIO_MEDIA_STREAM_URL` is set.
- `agent-connector` exposes `WS /twilio/media-stream` and bridges Twilio inbound media into voice STT pipeline.

## CI

- `.github/workflows/ci.yml` runs type checks for all apps on push/PR.
- The same workflow runs automation e2e smoke in `mock` mode on push/PR.
- OpenAI-backed e2e smoke runs on `workflow_dispatch` when `OPENAI_API_KEY` secret is configured.

## Secret hygiene

- Do not commit `.env` files or API keys.
- If a key is exposed in chat/logs, rotate it immediately.
