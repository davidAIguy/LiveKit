# Agent Connector

Service that receives validated launch payloads from `agent-runner` and can process simulated user turns into agent responses.

## Setup

1. Copy `.env.example` to `.env`.
2. Install dependencies: `npm install`.
3. Start service: `npm run dev`.

## Endpoints

- `GET /health`
- `GET /health/db`
- `GET /runtime/ai-mode`
- `POST /runtime/connect`
- `GET /runtime/sessions`
- `POST /runtime/sessions/:callId/user-turn`
- `GET /runtime/voice/sessions`
- `GET /runtime/voice/readiness`
- `POST /runtime/sessions/:callId/close`
- `WS /twilio/media-stream`
- `GET /mock-n8n/api/v1/workflows`
- `POST /mock-n8n/customer-lookup`
- `POST /mock-n8n/order-status`
- `POST /mock-n8n/create-ticket`

All `/mock-n8n/*` endpoints require one of:

- `Authorization: Bearer <MOCK_N8N_AUTH_SECRET>`
- `X-N8N-API-KEY: <MOCK_N8N_AUTH_SECRET>`

## Security

- Set `CONNECTOR_AUTH_TOKEN` to require bearer auth from `agent-runner`.

## Current behavior

- Registers active connector sessions per call.
- Stores user and agent turns in `utterances`.
- Appends runtime timeline events in `call_events`.
- Generates agent response via OpenAI when configured, or mock mode when `AGENT_CONNECTOR_MOCK_AI=true`.
- Supports direct tool execution command format in user turns: `/tool <tool_name> <json_input>`.
- Includes initial voice runtime wiring with provider adapters (Deepgram/Rime-Remi) and LiveKit transport modes.
- In `CONNECTOR_LIVEKIT_TRANSPORT_MODE=mock`, media publishing is no-op and emits runtime events only.
- In `CONNECTOR_LIVEKIT_TRANSPORT_MODE=auto`, connector uses `@livekit/rtc-node` transport to join room and publish an audio track.
- Deepgram adapter now opens realtime WS and emits transcript events to timeline (`runtime.voice_stt_transcript`).
- Final STT transcripts now trigger the same agent turn pipeline used by `/runtime/sessions/:callId/user-turn`.
- TTS adapters now attempt vendor HTTP synthesis when URL+key are configured (`rime`/`remi`), with synthetic fallback for local dev.
- Barge-in is enabled: inbound caller speech can interrupt current playout and emits `runtime.voice_barge_in_detected`.

## Automation Gateway command mode

When configured, a user turn like the following calls Control Plane Automation Gateway and records tool traces:

`/tool buscar_cliente {"email":"ana@demo.com"}`

Required env vars in `apps/agent-connector/.env`:

- `AUTOMATION_GATEWAY_BASE_URL`
- `AUTOMATION_GATEWAY_BEARER_TOKEN` (JWT bearer token accepted by control-plane API)
- `AUTOMATION_TOOL_COMMAND_PREFIX` (optional, default `/tool`)
- `MOCK_N8N_AUTH_SECRET` (for local mock n8n endpoints, default `local-dev-secret`)
- `CONNECTOR_VOICE_RUNTIME_ENABLED` (enable voice session manager)
- `CONNECTOR_LIVEKIT_TRANSPORT_MODE` (`mock` or `auto`)
- `STT_DEEPGRAM_API_KEY` (optional for Deepgram adapter readiness)
- `STT_DEEPGRAM_MODEL` and `STT_DEEPGRAM_LANGUAGE` (optional Deepgram realtime tuning)
- `STT_CONNECT_HARD_FAIL` (`true` to fail session start if STT provider cannot connect)
- `TWILIO_MEDIA_STREAM_TOKEN` (optional shared token expected from Twilio custom parameter)
- `TTS_RIME_API_KEY` or `TTS_REMI_API_KEY` (optional for Rime/Remi adapter readiness)
- `TTS_RIME_API_URL` / `TTS_REMI_API_URL` (provider endpoint for HTTP TTS)
- `TTS_RIME_API_URL` defaults to `https://users.rime.ai/v1/rime-tts`
- `TTS_RIME_SPEAKER`, `TTS_RIME_MODEL_ID` (Arcana payload fields)
- `VOICE_BARGE_IN_ENABLED`, `VOICE_BARGE_IN_ENERGY_THRESHOLD`, `VOICE_BARGE_IN_HOLD_MS`
- `TTS_REQUEST_TIMEOUT_MS`, `TTS_MAX_RETRIES`, `TTS_RETRY_BASE_DELAY_MS`

Expected TTS HTTP contract (adapter-level):

- Request JSON: `{ "text": "...", "format": "wav", "sample_rate_hz": 16000 }`
- Response can be either:
  - `audio/wav` (PCM16 WAV), or
  - JSON with base64 audio (`audio_base64` or `audio` or `data`) plus optional `format`, `sample_rate_hz`, `channels`.

For local bridge verification with outbound media required:

- `REQUIRE_TTS_OUTBOUND=true ./scripts/twilio-media-bridge-smoke-test.sh`
- `GET /runtime/voice/readiness` to inspect effective runtime/provider readiness.

Optional automatic tool-calling from natural language:

- `AUTOMATION_LLM_TOOL_CALLS_ENABLED=true`

When enabled (and OpenAI mode is active), connector fetches tool catalog from control-plane and lets the LLM choose between direct response vs tool execution.

## Enable real OpenAI responses

1. Set in `apps/agent-connector/.env`:
   - `AGENT_CONNECTOR_MOCK_AI=false`
   - `OPENAI_API_KEY=<your_key>`
2. Restart local stack.
3. Verify mode: `GET /runtime/ai-mode` with connector bearer token.
