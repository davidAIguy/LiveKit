#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:4000}"
CONNECTOR_URL="${CONNECTOR_URL:-http://localhost:4200}"
E2E_MODE="${E2E_MODE:-openai}" # openai | mock
TOOL_NAME="${TOOL_NAME:-health_check}"
TOOL_DESCRIPTION="${TOOL_DESCRIPTION:-Verifica disponibilidad del sistema local}"
TOOL_WEBHOOK_PATH="${TOOL_WEBHOOK_PATH:-/health}"
TOOL_METHOD="${TOOL_METHOD:-GET}"
INTEGRATION_BASE_URL="${INTEGRATION_BASE_URL:-http://localhost:4200}"
MOCK_INTEGRATION_SECRET="${MOCK_INTEGRATION_SECRET:-local-dev-secret}"

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

if [ -z "${DEV_BOOTSTRAP_KEY:-}" ]; then
  echo "DEV_BOOTSTRAP_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  echo "ENCRYPTION_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${CONNECTOR_AUTH_TOKEN:-}" ]; then
  echo "CONNECTOR_AUTH_TOKEN is required in apps/agent-connector/.env" >&2
  exit 1
fi

echo "Checking service health..."
curl -sf "$CONTROL_PLANE_URL/health" >/dev/null
curl -sf "$CONNECTOR_URL/health" >/dev/null

MODE_RESPONSE="$(curl -sS "$CONNECTOR_URL/runtime/ai-mode" -H "Authorization: Bearer $CONNECTOR_AUTH_TOKEN")"
MODE="$(printf '%s' "$MODE_RESPONSE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);console.log(j.mode || "");});')"

if [ "$E2E_MODE" = "openai" ] && [ "$MODE" != "openai" ]; then
  echo "agent-connector mode is '$MODE' but openai test was requested." >&2
  echo "Set AGENT_CONNECTOR_MOCK_AI=false and valid OPENAI_API_KEY, then restart agent-connector." >&2
  exit 1
fi

if [ "$E2E_MODE" = "mock" ] && [ "$MODE" != "mock_ai" ]; then
  echo "agent-connector mode is '$MODE' but mock test was requested." >&2
  echo "Set AGENT_CONNECTOR_MOCK_AI=true and restart agent-connector." >&2
  exit 1
fi

echo "Issuing internal admin token..."
TOKEN_RESPONSE="$(curl -sS -X POST "$CONTROL_PLANE_URL/internal/dev/token" \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: $DEV_BOOTSTRAP_KEY" \
  -d '{"user_id":"automation-smoke","tenant_id":"bootstrap-tenant","role":"internal_admin","is_internal":true,"expires_in":"2h"}')"

TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.token){process.exit(1);}console.log(j.token);});')"

echo "Ensuring smoke tenant/agent/call context..."
pushd "$ROOT_DIR/apps/control-plane-api" >/dev/null
CALL_CONTEXT="$({
  DATABASE_URL="$DATABASE_URL" \
  node <<'NODE'
(async () => {
  const pgMod = await import("pg");
  const Pool = pgMod.default.Pool;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const tenantName = "Smoke Test Tenant";
    const agentName = "Smoke Test Agent";

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

    const twilioCallSid = `CA_SMOKE_${Date.now()}`;
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

echo "Ensuring integration/tool/endpoint and agent tool mapping..."
pushd "$ROOT_DIR/apps/control-plane-api" >/dev/null
SETUP_JSON="$({
  DATABASE_URL="$DATABASE_URL" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  TENANT_ID="$TENANT_ID" \
  AGENT_ID="$AGENT_ID" \
  INTEGRATION_BASE_URL="$INTEGRATION_BASE_URL" \
  TOOL_NAME="$TOOL_NAME" \
  TOOL_DESCRIPTION="$TOOL_DESCRIPTION" \
  TOOL_WEBHOOK_PATH="$TOOL_WEBHOOK_PATH" \
  TOOL_METHOD="$TOOL_METHOD" \
  MOCK_INTEGRATION_SECRET="$MOCK_INTEGRATION_SECRET" \
  node <<'NODE'
(async () => {
  const pgMod = await import("pg");
  const cryptoMod = await import("node:crypto");
  const Pool = pgMod.default.Pool;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const tenantId = process.env.TENANT_ID;
    const agentId = process.env.AGENT_ID;
    const baseUrl = process.env.INTEGRATION_BASE_URL;
    const toolName = process.env.TOOL_NAME;
    const toolDescription = process.env.TOOL_DESCRIPTION;
    const webhookPath = process.env.TOOL_WEBHOOK_PATH;
    const method = (process.env.TOOL_METHOD || "GET").toUpperCase();

    const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
    const iv = cryptoMod.randomBytes(12);
    const cipher = cryptoMod.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(process.env.MOCK_INTEGRATION_SECRET || "local-dev-secret", "utf8"),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    const encryptedSecret = `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;

    const integrationRes = await pool.query(
      "select id from tenant_integrations where tenant_id = $1 and type = 'n8n_cloud' and base_url = $2 order by created_at desc limit 1",
      [tenantId, baseUrl]
    );
    let integrationId = "";
    if (integrationRes.rows.length > 0) {
      integrationId = integrationRes.rows[0].id;
      await pool.query(
        "update tenant_integrations set auth_type='bearer', encrypted_secret=$2, status='active', last_test_at=now() where id=$1",
        [integrationId, encryptedSecret]
      );
    } else {
      const integrationIns = await pool.query(
        "insert into tenant_integrations (tenant_id, type, base_url, auth_type, encrypted_secret, status, last_test_at) values ($1, 'n8n_cloud', $2, 'bearer', $3, 'active', now()) returning id",
        [tenantId, baseUrl, encryptedSecret]
      );
      integrationId = integrationIns.rows[0].id;
    }

    const toolRes = await pool.query("select id from tools where tenant_id = $1 and name = $2 limit 1", [
      tenantId,
      toolName
    ]);
    let toolId = "";
    if (toolRes.rows.length > 0) {
      toolId = toolRes.rows[0].id;
      await pool.query(
        "update tools set description = $2, input_schema_json = $3::jsonb, timeout_ms = 3000, max_retries = 1, enabled = true where id = $1",
        [toolId, toolDescription, JSON.stringify({ type: "object", additionalProperties: true })]
      );
    } else {
      const toolIns = await pool.query(
        "insert into tools (tenant_id, name, description, input_schema_json, timeout_ms, max_retries, enabled) values ($1, $2, $3, $4::jsonb, 3000, 1, true) returning id",
        [tenantId, toolName, toolDescription, JSON.stringify({ type: "object", additionalProperties: true })]
      );
      toolId = toolIns.rows[0].id;
    }

    const endpointRes = await pool.query(
      "select id from tool_endpoints where tool_id = $1 and integration_id = $2 and webhook_path = $3 and method = $4 limit 1",
      [toolId, integrationId, webhookPath, method]
    );
    let endpointId = "";
    if (endpointRes.rows.length > 0) {
      endpointId = endpointRes.rows[0].id;
    } else {
      const endpointIns = await pool.query(
        "insert into tool_endpoints (tool_id, integration_id, webhook_path, method, headers_template) values ($1, $2, $3, $4, '{}'::jsonb) returning id",
        [toolId, integrationId, webhookPath, method]
      );
      endpointId = endpointIns.rows[0].id;
    }

    const activeVersionRes = await pool.query(
      "select id from agent_versions where agent_id = $1 and published_at is not null order by published_at desc limit 1",
      [agentId]
    );

    let versionId = "";
    if (activeVersionRes.rows.length > 0) {
      versionId = activeVersionRes.rows[0].id;
    } else {
      const nextVersionRes = await pool.query(
        "select coalesce(max(version), 0) + 1 as next_version from agent_versions where agent_id = $1",
        [agentId]
      );
      const nextVersion = Number(nextVersionRes.rows[0].next_version);
      const versionIns = await pool.query(
        "insert into agent_versions (agent_id, version, system_prompt, temperature, published_at) values ($1, $2, $3, 0.3, now()) returning id",
        [
          agentId,
          nextVersion,
          "Eres un agente de validacion de plataforma. Usa herramientas para confirmar estado operativo."
        ]
      );
      versionId = versionIns.rows[0].id;
    }

    await pool.query(
      "insert into agent_tools (agent_version_id, tool_id) values ($1, $2) on conflict (agent_version_id, tool_id) do nothing",
      [versionId, toolId]
    );

    console.log(
      JSON.stringify({
        integration_id: integrationId,
        tool_id: toolId,
        endpoint_id: endpointId,
        active_version_id: versionId
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

echo "Setup: $SETUP_JSON"

TRACE_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"

echo "Opening connector session for call $CALL_ID..."
curl -sS -X POST "$CONNECTOR_URL/runtime/connect" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CONNECTOR_AUTH_TOKEN" \
  -d "{\"call_id\":\"$CALL_ID\",\"tenant_id\":\"$TENANT_ID\",\"agent_id\":\"$AGENT_ID\",\"trace_id\":\"$TRACE_ID\",\"room\":\"room-smoke-$CALL_ID\",\"twilio_call_sid\":\"$TWILIO_CALL_SID\",\"livekit_url\":\"https://livekit.invalid\",\"agent_join_token\":\"smoke-token\"}" >/dev/null

if [ "$E2E_MODE" = "openai" ]; then
  TURN_TEXT="Verifica la disponibilidad del sistema usando la herramienta $TOOL_NAME y dime el resultado."
  EXPECTED_SOURCE="llm_auto"
  echo "Sending natural-language turn (openai mode)..."
else
  TURN_TEXT="/tool $TOOL_NAME {}"
  EXPECTED_SOURCE="manual"
  echo "Sending explicit tool command (mock mode)..."
fi

TURN_RESPONSE="$(curl -sS -X POST "$CONNECTOR_URL/runtime/sessions/$CALL_ID/user-turn" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CONNECTOR_AUTH_TOKEN" \
  -d "{\"text\":\"$TURN_TEXT\"}")"

echo "Turn response: $TURN_RESPONSE"

printf '%s' "$TURN_RESPONSE" | node -e '
let d="";
process.stdin.on("data",c=>d+=c);
process.stdin.on("end",()=>{
  const j=JSON.parse(d);
  if(!j.ok){ console.error("User turn not ok", j); process.exit(1); }
  if(!j.tool_execution){ console.error("Missing tool_execution", j); process.exit(1); }
  if(j.tool_execution.status!=="success"){ console.error("Tool execution not success", j.tool_execution); process.exit(1); }
  console.log("Connector response validation passed");
});'

echo "Validating timeline events..."
EVENTS_RESPONSE="$(curl -sS "$CONTROL_PLANE_URL/internal/calls/$CALL_ID/events" -H "Authorization: Bearer $TOKEN")"

if [ "$E2E_MODE" = "openai" ]; then
  printf '%s' "$EVENTS_RESPONSE" | node -e '
  let d="";
  process.stdin.on("data",c=>d+=c);
  process.stdin.on("end",()=>{
    const j=JSON.parse(d);
    const items=j.items||[];
    const requested=items.find((ev)=>ev.type==="runtime.connector_tool_requested" && ev.payload_json && ev.payload_json.source==="llm_auto");
    const succeeded=items.find((ev)=>ev.type==="runtime.tool_execution_succeeded");
    if(!requested){ console.error("Missing llm_auto tool requested event"); process.exit(1); }
    if(!succeeded){ console.error("Missing tool execution succeeded event"); process.exit(1); }
    console.log("Timeline validation passed");
  });'
else
  printf '%s' "$EVENTS_RESPONSE" | node -e '
  let d="";
  process.stdin.on("data",c=>d+=c);
  process.stdin.on("end",()=>{
    const j=JSON.parse(d);
    const items=j.items||[];
    const requested=items.find((ev)=>ev.type==="runtime.connector_tool_requested");
    const succeeded=items.find((ev)=>ev.type==="runtime.tool_execution_succeeded");
    if(!requested){ console.error("Missing tool requested event"); process.exit(1); }
    if(!succeeded){ console.error("Missing tool execution succeeded event"); process.exit(1); }
    console.log("Timeline validation passed");
  });'
fi

echo "Automation E2E smoke test passed for call: $CALL_ID"
