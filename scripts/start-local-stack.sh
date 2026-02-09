#!/usr/bin/env bash
set -euo pipefail

mkdir -p .local-logs

start_service() {
  local name="$1"
  local cmd="$2"
  local pattern="$3"
  local log_file=".local-logs/${name}.log"

  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "${name} appears to be already running"
    return
  fi

  nohup bash -lc "$cmd" >"${log_file}" 2>&1 &
  local pid=$!
  echo "${name}:${pid}" >> .local-logs/pids
  echo "Started ${name} (pid ${pid})"
}

rm -f .local-logs/pids

start_service "control-plane-api" "npm --prefix apps/control-plane-api run dev" "apps/control-plane-api/node_modules/.bin/tsx watch src/index.ts"
start_service "agent-connector" "npm --prefix apps/agent-connector run dev" "apps/agent-connector/node_modules/.bin/tsx watch src/index.ts"
start_service "agent-runner" "npm --prefix apps/agent-runner run dev" "apps/agent-runner/node_modules/.bin/tsx watch src/index.ts"
start_service "voice-runtime-worker" "npm --prefix apps/voice-runtime-worker run dev" "apps/voice-runtime-worker/node_modules/.bin/tsx watch src/index.ts"
start_service "ops-debug-web" "npm --prefix apps/ops-debug-web run dev" "apps/ops-debug-web/node_modules/.bin/vite"

echo "Local stack start requested. Logs: .local-logs/*.log"
