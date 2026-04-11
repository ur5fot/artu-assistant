#!/bin/bash
# Ensures Ollama is running and the required model is pulled.
# Starts `ollama serve` in the background if needed, pulls model if missing.
set -e

OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:7b}"
OLLAMA_PID_FILE="/tmp/r2-ollama.pid"

# Clear stale PID file — we only write it if WE start the daemon this run.
rm -f "$OLLAMA_PID_FILE"

# Check if ollama binary exists
if ! command -v ollama >/dev/null 2>&1; then
  echo "ollama CLI not found; skipping local LLM setup (router will fall back to Claude)" >&2
  exit 0
fi

# Check if daemon is reachable
if curl -s -f "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
  echo "Ollama daemon is running"
else
  echo "Ollama daemon not running, starting in background..."
  # Start ollama serve detached, redirect logs to /tmp
  nohup ollama serve >/tmp/ollama.log 2>&1 &
  echo $! > "$OLLAMA_PID_FILE"
  # Wait up to 20s for daemon to be ready
  for i in {1..20}; do
    if curl -s -f "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
      echo "Ollama daemon ready"
      break
    fi
    sleep 1
  done
  if ! curl -s -f "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
    echo "Ollama daemon failed to start within 20s; router will fall back to Claude" >&2
    exit 0
  fi
fi

warmup_model() {
  # Preload the model into memory so the first real chat request doesn't
  # hit a cold start (qwen2.5:7b takes 30-60s to load the first time).
  # Use keep_alive: -1 to pin the model until the daemon is restarted.
  echo "Warming up ${OLLAMA_MODEL} (loading into memory)..."
  curl -s -X POST "${OLLAMA_URL}/api/generate" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${OLLAMA_MODEL}\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1}" \
    --max-time 120 >/dev/null 2>&1 &
  WARMUP_PID=$!
  echo "Warmup started in background (pid ${WARMUP_PID}); model will be ready in ~30-60s"
}

# Check if model is already pulled
if ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -q "^${OLLAMA_MODEL}$"; then
  echo "Ollama model ${OLLAMA_MODEL} already available"
  warmup_model
  exit 0
fi

echo "Pulling Ollama model ${OLLAMA_MODEL} (this may take several minutes)..."
if ollama pull "${OLLAMA_MODEL}"; then
  echo "Ollama model ${OLLAMA_MODEL} ready"
  warmup_model
else
  echo "Failed to pull ${OLLAMA_MODEL}; router will fall back to Claude" >&2
fi
