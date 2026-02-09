#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://localhost:4000}"

if [ ! -f "$ROOT_DIR/apps/control-plane-api/.env" ]; then
  echo "Missing env file: apps/control-plane-api/.env" >&2
  exit 1
fi

set -a
source "$ROOT_DIR/apps/control-plane-api/.env"
set +a

if [ -z "${DEV_BOOTSTRAP_KEY:-}" ]; then
  echo "DEV_BOOTSTRAP_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

TENANT_ID="${TENANT_ID:-}"
if [ -z "$TENANT_ID" ]; then
  pushd "$ROOT_DIR/apps/control-plane-api" >/dev/null
  TENANT_ID="$(node -e "(async()=>{const pg=await import('pg');const pool=new pg.default.Pool({connectionString:process.env.DATABASE_URL});const res=await pool.query('select tenant_id from calls order by started_at desc limit 1');if(res.rows.length===0){process.exit(1);}console.log(res.rows[0].tenant_id);await pool.end();})().catch(()=>process.exit(1));")"
  popd >/dev/null
fi

TOKEN_RESPONSE="$(curl -sS -X POST "$CONTROL_PLANE_URL/internal/dev/token" \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: $DEV_BOOTSTRAP_KEY" \
  -d "{\"user_id\":\"automation-gateway\",\"tenant_id\":\"$TENANT_ID\",\"role\":\"internal_operator\",\"is_internal\":true,\"expires_in\":\"7d\"}")"

TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);if(!j.token){console.error(d);process.exit(1);}console.log(j.token);});')"

echo "tenant_id=$TENANT_ID"
echo "token=$TOKEN"
