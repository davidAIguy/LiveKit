# Voice Agent Ops Platform - MVP PRD

## Goal

Build a multi-tenant voice AI platform where internal operators create and manage agents, and clients use a read-only portal for outcomes, recordings, and transcripts.

## Scope

- Inbound calls only.
- Internal Ops Console for agent lifecycle and integrations.
- Client Portal for KPIs, call history, recording playback, and transcripts.
- n8n Cloud integration per tenant via Automation Gateway.
- 30-day retention for sensitive call data with legal hold support.

## Core architecture

- Control Plane: tenants, users, RBAC, agents, versions, tools, phone assignments.
- Runtime Plane: LiveKit workers orchestrating STT -> LLM -> TTS loop.
- Automation Gateway: schema-validated tool execution against n8n Cloud.
- Data Plane: Postgres (system of record), Redis (ephemeral runtime state).
- Analytics: per-call metrics and daily KPI rollups.

## Runtime call flow

1. Caller reaches a Twilio number assigned to an agent.
2. Twilio triggers inbound webhook and session starts in LiveKit.
3. Audio streaming is transcribed by Deepgram.
4. OpenAI decides direct answer or tool call.
5. Tool call routes to Automation Gateway, then tenant n8n Cloud workflow.
6. Result returns to LLM context.
7. Final response synthesized by Rime and played back to caller.
8. Events, transcript turns, tool execution traces, and costs are persisted.

## Roles

- `internal_admin`: full platform control.
- `internal_operator`: day-to-day operations without critical security changes.
- `client_viewer`: read-only client access to KPIs and call-level artifacts.

## Data retention policy

- Retain `recordings`, `utterances`, and detailed `call_events` for 30 days.
- Exclude records tied to calls with `legal_hold=true`.
- Run daily cleanup jobs and log deletion outcomes for audit.

## MVP acceptance criteria

- End-to-end inbound call loop is functional.
- At least one tenant can connect n8n Cloud successfully.
- Tool execution includes schema validation, timeout, retry, and status tracking.
- Client portal exposes KPIs, call list, transcript, and recording playback.
- Retention cleanup and legal hold behavior are verifiable.

## Suggested build phases

1. Foundation: auth, RBAC, tenancy, base schema.
2. Telephony runtime: Twilio + LiveKit.
3. AI pipeline: Deepgram + OpenAI + Rime.
4. Automation Gateway: n8n Cloud connector and tool contract.
5. Portal and analytics: KPI and call observability.
6. Compliance hardening: retention, legal hold, audits.
