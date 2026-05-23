#!/bin/bash
# Dev entry point: starts Docker + Ollama, runs dev servers, cleans up on exit.
# Usage: ./scripts/dev.sh [mode]
#   mode: "plain" (default) | "tailnet" | "tunnel" | "named"
set -e

MODE="${1:-plain}"

./scripts/ensure-docker.sh
docker compose up -d

# Skip Ollama bootstrap when nothing in the stack needs it. Reads .env directly
# (the server validates these the same way at startup). Avoids loading ~5GB of
# qwen2.5:7b into RAM on machines that route everything through Claude/Voyage.
needs_ollama=1
if [ -f .env ]; then
  llm_mode=$(grep -E "^LOCAL_LLM_MODE=" .env | tail -1 | cut -d= -f2 | awk '{print $1}')
  embed=$(grep -E "^EMBEDDING_PROVIDER=" .env | tail -1 | cut -d= -f2 | awk '{print $1}')
  text=$(grep -E "^MEMORY_TEXT_PROVIDER=" .env | tail -1 | cut -d= -f2 | awk '{print $1}')
  # auto modes prefer Ollama if reachable, so they still count as "needs"
  if [ "$llm_mode" = "disabled" ] \
     && [ "$embed" != "ollama" ] && [ "$embed" != "auto" ] && [ -n "$embed" ] \
     && [ "$text" != "ollama" ] && [ "$text" != "auto" ] && [ -n "$text" ]; then
    needs_ollama=0
  fi
fi
if [ "$needs_ollama" = "1" ]; then
  ./scripts/ensure-ollama.sh
else
  echo "Skipping Ollama (LOCAL_LLM_MODE=disabled, memory uses ${embed}/${text})"
fi

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
    npx concurrently "npm run dev:server" "VITE_SUPERVISOR_WS_URL= npm run dev:client"
    ;;
  tailnet)
    if [ ! -d .tailnet-cert ] || [ -z "$(ls -A .tailnet-cert 2>/dev/null)" ]; then
      echo "hint: no Tailscale cert found — run 'npm run tailnet:cert' first for HTTPS."
      echo "hint: continuing with plain HTTP; PWA install will not work."
    fi
    npx concurrently "npm run dev:server" "VITE_HOST=true VITE_HTTPS=true npm run dev:client"
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
