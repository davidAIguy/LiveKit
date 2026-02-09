#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:4000}"
CONNECTOR_URL="${CONNECTOR_URL:-http://localhost:4200}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

require_cmd curl
require_cmd node

if [ ! -f "$ROOT_DIR/apps/control-plane-api/.env" ]; then
  echo "Missing env file: apps/control-plane-api/.env" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/apps/agent-connector/.env" ]; then
  echo "Missing env file: apps/agent-connector/.env" >&2
  exit 1
fi

set -a
source "$ROOT_DIR/apps/control-plane-api/.env"
source "$ROOT_DIR/apps/agent-connector/.env"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${DEV_BOOTSTRAP_KEY:-}" ]; then
  echo "DEV_BOOTSTRAP_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${CONNECTOR_AUTH_TOKEN:-}" ]; then
  echo "CONNECTOR_AUTH_TOKEN is required in apps/agent-connector/.env" >&2
  exit 1
fi

REQUIRE_TTS_OUTBOUND="${REQUIRE_TTS_OUTBOUND:-${CONNECTOR_VOICE_RUNTIME_ENABLED:-false}}"

echo "Checking service health..."
curl -sf "$CONTROL_PLANE_URL/health" >/dev/null
curl -sf "$CONNECTOR_URL/health" >/dev/null

echo "Issuing internal admin token..."
TOKEN_RESPONSE="$(curl -sS -X POST "$CONTROL_PLANE_URL/internal/dev/token" \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: $DEV_BOOTSTRAP_KEY" \
  -d '{"user_id":"twilio-media-smoke","tenant_id":"bootstrap-tenant","role":"internal_admin","is_internal":true,"expires_in":"2h"}')"

TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.token){process.exit(1);}console.log(j.token);});')"

echo "Ensuring call context..."
pushd "$ROOT_DIR/apps/control-plane-api" >/dev/null
CALL_CONTEXT="$({
  DATABASE_URL="$DATABASE_URL" \
  node <<'NODE'
(async () => {
  const pgMod = await import("pg");
  const Pool = pgMod.default.Pool;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const tenantName = "Twilio Smoke Tenant";
    const agentName = "Twilio Smoke Agent";

    let tenantId = "";
    const tenantRes = await pool.query("select id from tenants where name = $1 order by created_at asc limit 1", [
      tenantName
    ]);
    if (tenantRes.rows.length > 0) {
      tenantId = tenantRes.rows[0].id;
    } else {
      const tenantIns = await pool.query(
        "insert into tenants (name, timezone, plan, status) values ($1, 'UTC', 'starter', 'active') returning id",
        [tenantName]
      );
      tenantId = tenantIns.rows[0].id;
    }

    let agentId = "";
    const agentRes = await pool.query(
      "select id from agents where tenant_id = $1 and name = $2 order by created_at asc limit 1",
      [tenantId, agentName]
    );
    if (agentRes.rows.length > 0) {
      agentId = agentRes.rows[0].id;
    } else {
      const agentIns = await pool.query(
        "insert into agents (tenant_id, name, status, language, llm_model, stt_provider, tts_provider) values ($1, $2, 'draft', 'es', 'gpt-4o-mini', 'deepgram', 'rime') returning id",
        [tenantId, agentName]
      );
      agentId = agentIns.rows[0].id;
    }

    const versionRes = await pool.query(
      "select id from agent_versions where agent_id = $1 and published_at is not null order by published_at desc limit 1",
      [agentId]
    );
    if (versionRes.rows.length === 0) {
      const nextVersionRes = await pool.query(
        "select coalesce(max(version), 0) + 1 as next_version from agent_versions where agent_id = $1",
        [agentId]
      );
      const nextVersion = Number(nextVersionRes.rows[0].next_version);
      await pool.query(
        "insert into agent_versions (agent_id, version, system_prompt, temperature, published_at) values ($1, $2, $3, 0.3, now())",
        [
          agentId,
          nextVersion,
          "Eres un agente de voz. Responde en espanol breve y usa herramientas si ayudan."
        ]
      );
    }

    const twilioCallSid = `CA_TWILIO_SMOKE_${Date.now()}`;
    const room = `call-${twilioCallSid}`;
    const callIns = await pool.query(
      "insert into calls (tenant_id, agent_id, twilio_call_sid, livekit_room, started_at) values ($1, $2, $3, $4, now()) returning id, tenant_id, agent_id, twilio_call_sid",
      [tenantId, agentId, twilioCallSid, room]
    );

    console.log(
      JSON.stringify({
        call_id: callIns.rows[0].id,
        tenant_id: callIns.rows[0].tenant_id,
        agent_id: callIns.rows[0].agent_id,
        twilio_call_sid: callIns.rows[0].twilio_call_sid
      })
    );
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
} )"
popd >/dev/null

CALL_ID="$(printf '%s' "$CALL_CONTEXT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).call_id));')"
TENANT_ID="$(printf '%s' "$CALL_CONTEXT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).tenant_id));')"
AGENT_ID="$(printf '%s' "$CALL_CONTEXT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agent_id));')"
TWILIO_CALL_SID="$(printf '%s' "$CALL_CONTEXT" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).twilio_call_sid));')"
TRACE_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"

echo "Opening connector session for call $CALL_ID..."
curl -sS -X POST "$CONNECTOR_URL/runtime/connect" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CONNECTOR_AUTH_TOKEN" \
  -d "{\"call_id\":\"$CALL_ID\",\"tenant_id\":\"$TENANT_ID\",\"agent_id\":\"$AGENT_ID\",\"trace_id\":\"$TRACE_ID\",\"room\":\"room-twilio-smoke-$CALL_ID\",\"twilio_call_sid\":\"$TWILIO_CALL_SID\",\"livekit_url\":\"https://livekit.invalid\",\"agent_join_token\":\"smoke-token\"}" >/dev/null

echo "Running Twilio media websocket simulation..."
pushd "$ROOT_DIR/apps/agent-connector" >/dev/null
WS_RESULT="$({
  CALL_ID="$CALL_ID" \
  TWILIO_CALL_SID="$TWILIO_CALL_SID" \
  CONNECTOR_URL="$CONNECTOR_URL" \
  CONNECTOR_AUTH_TOKEN="$CONNECTOR_AUTH_TOKEN" \
  TWILIO_MEDIA_STREAM_TOKEN="${TWILIO_MEDIA_STREAM_TOKEN:-}" \
  REQUIRE_TTS_OUTBOUND="$REQUIRE_TTS_OUTBOUND" \
  node <<'NODE'
(async () => {
  const wsMod = await import("ws");
  const WebSocket = wsMod.WebSocket;

  const callId = process.env.CALL_ID;
  const callSid = process.env.TWILIO_CALL_SID;
  const connectorUrl = process.env.CONNECTOR_URL;
  const connectorAuth = process.env.CONNECTOR_AUTH_TOKEN;
  const token = process.env.TWILIO_MEDIA_STREAM_TOKEN || "";
  const requireOutbound = process.env.REQUIRE_TTS_OUTBOUND === "true";

  const url = new URL(connectorUrl || "http://localhost:4200");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/twilio/media-stream";
  if (token) {
    url.searchParams.set("token", token);
  }

  const streamSid = `MZ${Date.now()}`;
  const silencePayload = Buffer.alloc(160, 0xff).toString("base64");

  let started = false;
  let stopped = false;
  let outboundMedia = false;
  let outboundClear = false;

  const socket = new WebSocket(url.toString());

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.event === "media") {
        outboundMedia = true;
      }
      if (message.event === "clear") {
        outboundClear = true;
      }
    } catch {
      // ignore non-json
    }
  });

  socket.send(JSON.stringify({ event: "connected", streamSid }));
  socket.send(
    JSON.stringify({
      event: "start",
      streamSid,
      start: {
        callSid,
        customParameters: token ? { token } : {}
      }
    })
  );
  started = true;

  for (let i = 0; i < 8; i += 1) {
    socket.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: silencePayload
        }
      })
    );
  }

  const userTurnResponse = await fetch(`${connectorUrl}/runtime/sessions/${callId}/user-turn`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${connectorAuth}`
    },
    body: JSON.stringify({ text: "Hola, dime un estado breve de la llamada" })
  });
  if (!userTurnResponse.ok) {
    const text = await userTurnResponse.text();
    throw new Error(`user_turn_failed_${userTurnResponse.status}:${text}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  socket.send(JSON.stringify({ event: "stop", streamSid }));
  stopped = true;
  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.close();

  if (requireOutbound && !outboundMedia) {
    throw new Error("twilio_bridge_missing_outbound_media");
  }

  console.log(
    JSON.stringify({
      started,
      stopped,
      outbound_media: outboundMedia,
      outbound_clear: outboundClear,
      require_tts_outbound: requireOutbound
    })
  );
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
} )"
popd >/dev/null

echo "Websocket result: $WS_RESULT"

echo "Validating Twilio media events..."
EVENTS_RESPONSE="$(curl -sS "$CONTROL_PLANE_URL/internal/calls/$CALL_ID/events" -H "Authorization: Bearer $TOKEN")"

printf '%s' "$EVENTS_RESPONSE" | node -e '
let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  const j=JSON.parse(d);
  const items=j.items||[];
  const started=items.find((ev)=>ev.type==="runtime.twilio_media_stream_started");
  const stopped=items.find((ev)=>ev.type==="runtime.twilio_media_stream_stopped");
  if(!started){ console.error("Missing runtime.twilio_media_stream_started"); process.exit(1); }
  if(!stopped){ console.error("Missing runtime.twilio_media_stream_stopped"); process.exit(1); }
  console.log("Twilio media event validation passed");
});'

echo "Twilio media bridge smoke test passed for call: $CALL_ID"
