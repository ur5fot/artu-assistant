#!/bin/bash
# Dev entry point: starts Docker + Ollama, runs dev servers, cleans up on exit.
# Usage: ./scripts/dev.sh [mode]
#   mode: "plain" (default) | "tunnel" | "named"
set -e

MODE="${1:-plain}"

./scripts/ensure-docker.sh
docker compose up -d
./scripts/ensure-ollama.sh

cleanup() {
  echo ""
  echo "Shutting down dev environment..."
  docker compose down 2>/dev/null || true
  if [ -f /tmp/r2-ollama.pid ]; then
    PID=$(cat /tmp/r2-ollama.pid 2>/dev/null || echo "")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "Stopping Ollama (pid $PID)..."
      kill "$PID" 2>/dev/null || true
    fi
    rm -f /tmp/r2-ollama.pid
  fi
}
trap cleanup EXIT INT TERM

case "$MODE" in
  plain)
    npx concurrently "npm run dev:server" "npm run dev:client"
    ;;
  tunnel)
    npx concurrently "npm run dev:server" "VITE_HOST=true npm run dev:client" "sleep 5 && npm run tunnel"
    ;;
  named)
    npx concurrently "npm run dev:server" "VITE_HOST=true npm run dev:client" "cloudflared tunnel run"
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
