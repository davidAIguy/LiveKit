# Ops Debug Web

SaaS operator portal for tenant onboarding, agent setup, and runtime operations.

## Features

- Sign in with email/password via `/auth/login`.
- Run first-admin bootstrap from UI via `/auth/register-first-admin` (one-time).
- Login-first UX; JWT handling stays internal to the app.
- Phone routing UI: register Twilio phone numbers and assign each number to an agent.
- Load KPI cards and KPI rows from `/client/kpis`.
- Filter analytics by date range and optional `agent_id`.
- List calls from `/client/calls` with active/ended state.
- View call timeline from `/internal/calls/:callId/events`.
- Persist dashboard config in `localStorage` and optional auto-refresh.
- SaaS admin flows: list/create tenants, list/create agents, create/publish agent versions.
- Workspace CRM view: tenant table, search, and tenant detail snapshot.
- Guided Agent Builder wizard (identity -> speech/model -> prompt/publish).
- Agent settings editor: update initial greeting and voice id.
- Phone routing UI: add Twilio numbers and assign each number to an agent.

## Run

1. Ensure local backend stack is running.
2. Install deps: `npm install`
3. Start UI: `npm run dev`
4. Open: `http://localhost:4300`
