#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROVIDER="${1:-rime}"
TEXT="${TEXT:-Hola, esta es una prueba de sintesis para validar el proveedor de TTS.}"

if [ ! -f "$ROOT_DIR/apps/agent-connector/.env" ]; then
  echo "Missing env file: apps/agent-connector/.env" >&2
  exit 1
fi

set -a
source "$ROOT_DIR/apps/agent-connector/.env"
set +a

API_URL=""
API_KEY=""
case "$PROVIDER" in
  rime)
    API_URL="${TTS_RIME_API_URL:-https://users.rime.ai/v1/rime-tts}"
    API_KEY="${TTS_RIME_API_KEY:-}"
    ;;
  remi)
    API_URL="${TTS_REMI_API_URL:-}"
    API_KEY="${TTS_REMI_API_KEY:-}"
    ;;
  *)
    echo "Unknown provider '$PROVIDER'. Use 'rime' or 'remi'." >&2
    exit 1
    ;;
esac

if [ -z "$API_KEY" ]; then
  echo "Provider '$PROVIDER' is not configured in apps/agent-connector/.env" >&2
  echo "Expected ${PROVIDER^^}_API_KEY (URL is optional for rime default endpoint)" >&2
  exit 1
fi

echo "Probing TTS provider '$PROVIDER' at $API_URL"

RESPONSE_FILE="$(mktemp)"
HEADER_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE" "$HEADER_FILE"' EXIT

HTTP_CODE="$(curl -sS -o "$RESPONSE_FILE" -D "$HEADER_FILE" -w "%{http_code}" \
  -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: audio/wav, application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"text\":\"$TEXT\",\"speaker\":\"${TTS_RIME_SPEAKER:-celeste}\",\"modelId\":\"${TTS_RIME_MODEL_ID:-arcana}\",\"format\":\"wav\",\"sample_rate_hz\":16000}")"

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "TTS probe failed with HTTP $HTTP_CODE" >&2
  exit 1
fi

CONTENT_TYPE="$(node -e "const fs=require('fs');const raw=fs.readFileSync(process.argv[1],'utf8');const line=raw.split(/\r?\n/).find((l)=>l.toLowerCase().startsWith('content-type:'));console.log(line?line.split(':').slice(1).join(':').trim().toLowerCase():'');" "$HEADER_FILE")"

node -e '
const fs = require("fs");
const ct = (process.argv[1] || "").toLowerCase();
const path = process.argv[2];
const body = fs.readFileSync(path);

if (ct.includes("audio/wav") || ct.includes("audio/x-wav")) {
  if (body.length < 44) {
    console.error("WAV too short");
    process.exit(1);
  }
  const riff = body.toString("ascii", 0, 4);
  const wave = body.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    console.error("Invalid WAV header");
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, format: "wav", bytes: body.length }));
  process.exit(0);
}

if (ct.includes("application/json")) {
  const payload = JSON.parse(body.toString("utf8"));
  const audioBase64 = payload.audio_base64 || payload.audio || payload.data;
  if (!audioBase64 || typeof audioBase64 !== "string") {
    console.error("JSON response missing audio base64 field");
    process.exit(1);
  }
  const audio = Buffer.from(audioBase64, "base64");
  console.log(JSON.stringify({ ok: true, format: payload.format || "unknown", bytes: audio.length }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, format: "unknown", bytes: body.length }));
' "$CONTENT_TYPE" "$RESPONSE_FILE"

echo "TTS probe passed"
