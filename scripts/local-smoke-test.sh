#!/usr/bin/env bash
set -euo pipefail

CONTROL_PLANE_URL="http://localhost:4000"
DEV_BOOTSTRAP_KEY="a10159516f8d5a7e2b493824a02376691c2dda52b6afe9c6"

echo "Checking health endpoints..."
curl -sf "${CONTROL_PLANE_URL}/health" >/dev/null
curl -sf "http://localhost:4100/health" >/dev/null
curl -sf "http://localhost:4200/health" >/dev/null

echo "Issuing internal JWT..."
TOKEN=$(curl -sS -X POST "${CONTROL_PLANE_URL}/internal/dev/token" \
  -H "Content-Type: application/json" \
  -H "x-dev-bootstrap-key: ${DEV_BOOTSTRAP_KEY}" \
  -d '{"user_id":"local-admin","tenant_id":"11111111-1111-1111-1111-111111111111","role":"internal_admin","is_internal":true,"expires_in":"1h"}' | node -e 'process.stdin.once("data", d => console.log(JSON.parse(d).token))')

echo "Token issued: ${TOKEN:0:16}..."
echo "Smoke test baseline passed."
