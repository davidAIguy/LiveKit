# Ops Debug Web

SaaS operator portal for tenant onboarding, agent setup, and runtime operations.

## Features

- Issue JWT from `/internal/dev/token`.
- Sign in with email/password via `/auth/login`.
- Run first-admin bootstrap from UI via `/auth/register-first-admin` (one-time).
- Load KPI cards and KPI rows from `/client/kpis`.
- Filter analytics by date range and optional `agent_id`.
- List calls from `/client/calls` with active/ended state.
- View call timeline from `/internal/calls/:callId/events`.
- Accept manual JWT paste for production environments where `/internal/dev/token` is disabled.
- Persist dashboard config in `localStorage` and optional auto-refresh.
- SaaS admin flows: list/create tenants, list/create agents, create/publish agent versions.
- Send simulated user turns to `agent-connector` and inspect AI responses in timeline.
- Check connector AI mode (`mock_ai`, `openai`, `openai_unconfigured`).

## Run

1. Ensure local backend stack is running.
2. Install deps: `npm install`
3. Start UI: `npm run dev`
4. Open: `http://localhost:4300`
