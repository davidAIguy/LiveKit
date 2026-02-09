# Ops Debug Web

Minimal local UI for operational debugging.

## Features

- Issue JWT from `/internal/dev/token`.
- List calls from `/client/calls`.
- View call timeline from `/internal/calls/:callId/events`.
- Send simulated user turns to `agent-connector` and inspect AI responses in timeline.
- Check connector AI mode (`mock_ai`, `openai`, `openai_unconfigured`).

## Run

1. Ensure local backend stack is running.
2. Install deps: `npm install`
3. Start UI: `npm run dev`
4. Open: `http://localhost:4300`
