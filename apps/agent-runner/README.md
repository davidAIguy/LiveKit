# Agent Runner

Receives runtime launch requests and validates LiveKit join tokens before forwarding to an agent connector process.

## Setup

1. Copy `.env.example` to `.env`.
2. Install dependencies: `npm install`.
3. Start service: `npm run dev`.

## Endpoints

- `GET /health`
- `POST /runtime/agent-sessions/launch`
- `GET /runtime/agent-sessions/launches/stats`

## Launch endpoint contract

`POST /runtime/agent-sessions/launch` expects:

- `call_id`
- `tenant_id`
- `agent_id`
- `trace_id`
- `room`
- `twilio_call_sid`
- `livekit_url`
- `agent_join_token`

The service verifies the LiveKit token signature and room/identity grants. If `AGENT_CONNECTOR_URL` is set, it forwards the payload to that connector; otherwise it runs in noop mode (logs accepted launch only).

Recommended local connector URL: `http://localhost:4200/runtime/connect`

## Security

- Set `RUNNER_AUTH_TOKEN` to require bearer auth from `voice-runtime-worker`.
- Set `AGENT_CONNECTOR_AUTH_TOKEN` to secure downstream connector calls.
