# Control Plane API

Initial backend service for the Voice Agent Ops Platform.

## Features included

- Fastify server with health endpoints.
- JWT auth with role and tenant claims.
- Role guards for internal and client routes.
- Internal endpoints for tenants, agents, phone number routing, versions, tools, n8n integration test, and legal hold.
- Production auth endpoints for first-admin setup and email/password login.
- Automation Gateway endpoints to execute tenant tools against n8n Cloud with timeout/retry and execution tracing.
- Client read-only endpoints for KPIs, calls, transcript, and recording metadata.
- Public Twilio inbound webhook scaffold that creates/updates call sessions.

## Setup

1. Copy `.env.example` to `.env`.
2. Ensure Postgres is running and run migrations from `db/migrations/0001_init.sql`, `db/migrations/0002_call_events_processing.sql`, `db/migrations/0003_runtime_dispatches.sql`, `db/migrations/0004_call_events_dispatch_queue.sql`, and `db/migrations/0005_runtime_launch_jobs.sql`.
3. Install dependencies: `npm install`.
4. Start development server: `npm run dev`.

## Auth for local testing

Use a bearer token on all non-public endpoints:

- `Authorization: Bearer <token>`

Required JWT claims:

- `sub`
- `tenant_id`
- `role` (`internal_admin`, `internal_operator`, `client_viewer`)
- `is_internal` (`true` or `false`)

Quick bootstrap token endpoint for local/staging:

```bash
curl -X POST http://localhost:4000/internal/dev/token \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: $DEV_BOOTSTRAP_KEY" \
  -d '{"user_id":"user-1","tenant_id":"tenant-1","role":"internal_admin","is_internal":true,"expires_in":"1h"}'
```

Manual token generation:

```bash
node -e "const jwt=require('jsonwebtoken'); console.log(jwt.sign({sub:'user-1',tenant_id:'tenant-1',role:'internal_admin',is_internal:true}, process.env.JWT_SECRET, {issuer:process.env.JWT_ISSUER,audience:process.env.JWT_AUDIENCE,expiresIn:'1h'}));"
```

## Production-friendly auth endpoints

- `POST /auth/register-first-admin`
  - One-time bootstrap when there are no users.
  - Creates tenant + first internal admin and returns JWT.

- `POST /auth/login`
  - Body: `email`, `password`, optional `tenant_id`.
  - Returns JWT and memberships.

- `POST /auth/bootstrap/user`
  - Guarded by `x-auth-bootstrap-key: $AUTH_BOOTSTRAP_KEY`.
  - Creates additional users and memberships without exposing dev token route.

## Public endpoints

- `GET /health`
- `GET /health/db`
- `POST /twilio/webhook/inbound`
- `POST /internal/dev/token` (disabled in production)
- `POST /auth/register-first-admin`
- `POST /auth/login`
- `POST /auth/bootstrap/user` (requires bootstrap key)

## n8n integration test endpoint

- `POST /internal/integrations/n8n/test`
- Body fields: `tenant_id`, `base_url`, `auth_type`, `secret`
- Behavior: tests connectivity with timeout/retry before storing encrypted secret.

## Phone routing endpoints

- `GET /internal/phone-numbers?tenant_id=<uuid>&limit=200`
- `POST /internal/phone-numbers`
  - Body fields: `tenant_id`, `e164`, `twilio_sid`, optional `agent_id`, optional `status`
- `PATCH /internal/phone-numbers/:phoneNumberId/agent`
  - Body fields: `agent_id` (`uuid` or `null`)
- Behavior: maps inbound Twilio number (`To`) to tenant/agent used by webhook handoff.

## Automation Gateway endpoints

- `POST /internal/tools/:toolId/endpoints`
- Body fields: `integration_id`, `webhook_path`, `method`, `headers_template`
- Behavior: links a tool to a tenant n8n integration endpoint.

- `POST /internal/agents/:agentId/versions/:versionId/tools`
- Body fields: `tool_ids`
- Behavior: assigns the allowlist of tools for an agent version.

- `GET /internal/automation/tools/catalog?call_id=<uuid>`
- Behavior: returns available tools for the call tenant and (when enabled) only tools mapped to the call agent active version.

- `POST /internal/automation/tools/by-name/:toolName/execute`
- `POST /internal/automation/tools/:toolId/execute`
- Body fields: `call_id`, `input_json`, `trace_id` (optional)
- Behavior: validates input against tool JSON Schema, enforces allowlist mapping guardrail, enforces per-call execution rate limit, calls n8n endpoint with timeout/retry, stores `tool_executions`, and appends timeline events.

## Runtime dispatch claim endpoint

- `POST /internal/runtime/dispatches/claim`
- Body fields: `dispatch_id`
- Auth: internal JWT role (`internal_admin` or `internal_operator`) with tenant isolation.
- Behavior: atomically claims a pending dispatch, returns join token once, and scrubs token from DB record.

## Twilio webhook validation

- Signature validation is enabled with `TWILIO_VALIDATE_SIGNATURE=true`.
- Requires `TWILIO_AUTH_TOKEN` and `TWILIO_WEBHOOK_BASE_URL`.
- Disable only for local smoke tests where Twilio signatures are unavailable.
- On valid calls, the webhook also emits `runtime.handoff_requested` event payloads for the runtime worker.
- If `TWILIO_MEDIA_STREAM_URL` is configured, webhook responds with `<Connect><Stream>` TwiML instead of immediate hangup.
- Set `TWILIO_MEDIA_STREAM_TOKEN` to inject a shared token parameter in Twilio stream start payload.

## Notes

- JWT secret and encryption key are mandatory.
- Secret storage currently uses app-level AES-GCM; wire KMS for production.
- Dev token route requires `DEV_BOOTSTRAP_KEY` and is disabled in production.
- Auth bootstrap route uses `AUTH_BOOTSTRAP_KEY` (recommended in staging/ops only).
- `AUTOMATION_MAX_EXECUTIONS_PER_MINUTE` controls per-call rate limiting.
- `AUTOMATION_REQUIRE_AGENT_TOOL_MAPPING=true` enforces agent-version tool allowlist.
- Schedule `db/jobs/expire_runtime_dispatches.sql` to expire stale pending dispatches.
