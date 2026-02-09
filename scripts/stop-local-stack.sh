#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .local-logs/pids ]; then
  echo "No pid file found (.local-logs/pids). Attempting pattern-based stop."
fi

if [ -f .local-logs/pids ]; then
  while IFS=: read -r name pid; do
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      echo "Stopped ${name} (pid ${pid})"
    else
      echo "${name} already stopped (pid ${pid})"
    fi
  done < .local-logs/pids
fi

for pattern in \
  "apps/control-plane-api/node_modules/.bin/tsx watch src/index.ts" \
  "apps/agent-connector/node_modules/.bin/tsx watch src/index.ts" \
  "apps/agent-runner/node_modules/.bin/tsx watch src/index.ts" \
  "apps/voice-runtime-worker/node_modules/.bin/tsx watch src/index.ts" \
  "apps/ops-debug-web/node_modules/.bin/vite"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    pkill -f "$pattern" >/dev/null 2>&1 || true
    echo "Stopped processes matching: $pattern"
  fi
done

rm -f .local-logs/pids
