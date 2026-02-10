#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:4000}"
CONNECTOR_URL="${CONNECTOR_URL:-http://localhost:4200}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-60}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-2}"
FORCE_KPI_ROLLUP="${FORCE_KPI_ROLLUP:-true}"

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
if [ -f "$ROOT_DIR/apps/voice-runtime-worker/.env" ]; then
  source "$ROOT_DIR/apps/voice-runtime-worker/.env"
fi
set +a

if [ -z "${DEV_BOOTSTRAP_KEY:-}" ]; then
  echo "DEV_BOOTSTRAP_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required in env files" >&2
  exit 1
fi

if [ -z "${CONNECTOR_AUTH_TOKEN:-}" ]; then
  echo "CONNECTOR_AUTH_TOKEN is required in apps/agent-connector/.env" >&2
  exit 1
fi

echo "Checking service health..."
curl -sf "$CONTROL_PLANE_URL/health" >/dev/null
curl -sf "$CONNECTOR_URL/health" >/dev/null

echo "Running Twilio media smoke to generate a real call..."
SMOKE_OUTPUT="$($ROOT_DIR/scripts/twilio-media-bridge-smoke-test.sh)"
printf '%s\n' "$SMOKE_OUTPUT"

CALL_ID="$(printf '%s' "$SMOKE_OUTPUT" | node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const match = data.match(/Twilio media bridge smoke test passed for call:\s*([a-f0-9-]+)/i);
  if (!match) {
    process.exit(1);
  }
  process.stdout.write(match[1]);
});')"

if [ -z "$CALL_ID" ]; then
  echo "Unable to extract call id from smoke output" >&2
  exit 1
fi

echo "Validating ingestion projection for call $CALL_ID..."
ATTEMPTS=$((MAX_WAIT_SECONDS / POLL_INTERVAL_SECONDS))
SNAPSHOT_JSON=""
INGESTION_OK="false"

for ((i=1; i<=ATTEMPTS; i+=1)); do
  SNAPSHOT_JSON="$(CALL_ID="$CALL_ID" DATABASE_URL="$DATABASE_URL" node <<'NODE'
(async () => {
  const pgMod = await import("./apps/control-plane-api/node_modules/pg/lib/index.js");
  const pool = new pgMod.default.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query(
      `select
         c.id,
         c.tenant_id,
         c.agent_id,
         c.started_at,
         c.ended_at,
         c.outcome,
         c.handoff_reason,
         coalesce(cm.total_ms, 0)::int as total_ms,
         coalesce(cm.tool_ms_total, 0)::int as tool_ms_total
       from calls c
       left join call_metrics cm on cm.call_id = c.id
       where c.id = $1
       limit 1`,
      [process.env.CALL_ID]
    );

    if (res.rows.length === 0) {
      process.exit(2);
    }

    process.stdout.write(JSON.stringify(res.rows[0]));
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
)"

  INGESTION_OK="$(printf '%s' "$SNAPSHOT_JSON" | node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const s = JSON.parse(data);
  const ok = Boolean(s.ended_at) && Number(s.total_ms) > 0;
  process.stdout.write(ok ? "true" : "false");
});')"

  if [ "$INGESTION_OK" = "true" ]; then
    break
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done

if [ "$INGESTION_OK" != "true" ]; then
  echo "Ingestion validation failed: call did not get ended_at/total_ms within ${MAX_WAIT_SECONDS}s" >&2
  echo "Snapshot: $SNAPSHOT_JSON" >&2
  exit 1
fi

TENANT_ID="$(printf '%s' "$SNAPSHOT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).tenant_id));')"
AGENT_ID="$(printf '%s' "$SNAPSHOT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).agent_id));')"
CALL_DAY="$(printf '%s' "$SNAPSHOT_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(d).started_at).slice(0,10)));')"

if [ "$FORCE_KPI_ROLLUP" = "true" ]; then
  echo "Force-refreshing daily_kpis for immediate validation..."
  LOOKBACK_DAYS="${KPI_LOOKBACK_DAYS:-35}"
  DATABASE_URL="$DATABASE_URL" LOOKBACK_DAYS="$LOOKBACK_DAYS" node <<'NODE'
(async () => {
  const pgMod = await import("./apps/control-plane-api/node_modules/pg/lib/index.js");
  const pool = new pgMod.default.Pool({ connectionString: process.env.DATABASE_URL });
  const lookbackDays = Number(process.env.LOOKBACK_DAYS || "35");

  try {
    await pool.query("begin");

    const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await pool.query("delete from daily_kpis where day >= $1::date", [cutoffDate]);

    await pool.query(
      `insert into daily_kpis (
         day,
         tenant_id,
         agent_id,
         calls,
         avg_duration_sec,
         resolution_rate,
         handoff_rate,
         total_cost_usd
       )
       select
         date_trunc('day', c.started_at at time zone 'UTC')::date as day,
         c.tenant_id,
         c.agent_id,
         count(*)::int as calls,
         coalesce(
           round(
             avg(
               case
                 when c.ended_at is not null and c.ended_at >= c.started_at
                   then extract(epoch from (c.ended_at - c.started_at))
                 else null
               end
             )
           )::int,
           0
         ) as avg_duration_sec,
         coalesce(
           round((count(*) filter (where c.outcome = 'resolved'))::numeric * 100 / nullif(count(*), 0), 2),
           0
         )::numeric(5,2) as resolution_rate,
         coalesce(
           round(
             (
               count(*) filter (where c.outcome = 'handoff' or c.handoff_reason is not null)
             )::numeric * 100 / nullif(count(*), 0),
             2
           ),
           0
         )::numeric(5,2) as handoff_rate,
         coalesce(sum(cm.cost_usd), 0)::numeric(12,6) as total_cost_usd
       from calls c
       left join call_metrics cm on cm.call_id = c.id
       where c.started_at >= $1::timestamptz
       group by 1, 2, 3`,
      [cutoffDate]
    );

    await pool.query("commit");
  } catch (error) {
    await pool.query("rollback");
    throw error;
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE
fi

echo "Issuing client_viewer token..."
TOKEN_RESPONSE="$(curl -sS -X POST "$CONTROL_PLANE_URL/internal/dev/token" \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: $DEV_BOOTSTRAP_KEY" \
  -d "{\"user_id\":\"kpi-validator\",\"tenant_id\":\"$TENANT_ID\",\"role\":\"client_viewer\",\"is_internal\":false,\"expires_in\":\"1h\"}")"

CLIENT_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const parsed = JSON.parse(data);
  if (!parsed.token) {
    process.exit(1);
  }
  process.stdout.write(parsed.token);
});')"

FROM_TS="$(node -e 'const d=new Date(Date.now()-30*24*60*60*1000); process.stdout.write(d.toISOString());')"
TO_TS="$(node -e 'const d=new Date(Date.now()+24*60*60*1000); process.stdout.write(d.toISOString());')"

KPI_RESPONSE="$(curl -sS "$CONTROL_PLANE_URL/client/kpis?from=$FROM_TS&to=$TO_TS&agent_id=$AGENT_ID" -H "Authorization: Bearer $CLIENT_TOKEN")"
CALLS_RESPONSE="$(curl -sS "$CONTROL_PLANE_URL/client/calls?from=$FROM_TS&to=$TO_TS&agent_id=$AGENT_ID" -H "Authorization: Bearer $CLIENT_TOKEN")"

printf '%s' "$KPI_RESPONSE" | CALL_DAY="$CALL_DAY" TENANT_ID="$TENANT_ID" AGENT_ID="$AGENT_ID" node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const payload = JSON.parse(data);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const row = items.find((item) => item.day === process.env.CALL_DAY && item.tenant_id === process.env.TENANT_ID && item.agent_id === process.env.AGENT_ID);
  if (!row) {
    console.error("Missing KPI row for call day/tenant/agent");
    process.exit(1);
  }
});'

printf '%s' "$CALLS_RESPONSE" | CALL_ID="$CALL_ID" node -e '
let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  const payload = JSON.parse(data);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const row = items.find((item) => item.id === process.env.CALL_ID);
  if (!row) {
    console.error("Missing call in /client/calls response");
    process.exit(1);
  }
  if (!row.ended_at) {
    console.error("Call exists but ended_at is null in /client/calls response");
    process.exit(1);
  }
});'

echo "Validation passed"
echo "- call_id: $CALL_ID"
echo "- tenant_id: $TENANT_ID"
echo "- agent_id: $AGENT_ID"
echo "- call_day: $CALL_DAY"
echo "- ingestion: ended_at + call_metrics total_ms verified"
echo "- api: /client/calls and /client/kpis verified"
