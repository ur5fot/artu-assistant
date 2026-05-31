#!/usr/bin/env bash
#
# r2-service.sh — launchd wrapper that runs the R2 supervisor always-on.
#
# Invoked by the LaunchAgent as `/bin/zsh -lc <this script>` so a login shell
# has already sourced the user profile (nvm → node on PATH). Responsibilities:
#   1. cd into the repo root (resolved from this script's location).
#   2. Make sure `node` is reachable.
#   3. Best-effort `docker compose up -d` (code-task tools need it; must not
#      block startup if Docker is down).
#   4. Refuse to start if port 3004 is already taken (likely `npm run dev`),
#      to avoid two workers fighting over the port.
#   5. exec the supervisor via tsx so deploys (git pull master) are picked up
#      without a build step.

set -euo pipefail

# Worker (server) port. The supervisor forks the worker which binds this; if it
# is already held, an interactive `npm run dev` is probably running.
WORKER_PORT="${R2_WORKER_PORT:-3004}"

log() {
  printf '[r2-service] %s\n' "$*" >&2
}

# Resolve the repo root from this script's location (scripts/ is one level down)
# so the wrapper works regardless of the launchd working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# node must be on PATH. The login shell (-l) should have loaded nvm; fail loudly
# with a clear message if it did not, rather than dying inside npx.
if ! command -v node >/dev/null 2>&1; then
  log "error: 'node' not found on PATH; ensure the login shell loads nvm/node"
  exit 1
fi
log "using node $(node --version) at $(command -v node)"

# Guard: refuse to start if the worker port is already bound (e.g. `npm run dev`).
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"${WORKER_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    log "error: port ${WORKER_PORT} is already in use — is 'npm run dev' running?"
    log "stop the dev server before starting the always-on service."
    exit 1
  fi
fi

# Best-effort Docker bring-up. Never fatal: code-task tools want it, but the
# supervisor and worker run fine without it.
if command -v docker >/dev/null 2>&1; then
  log "bringing up docker compose services (best-effort)"
  docker compose up -d || log "warning: 'docker compose up -d' failed; continuing"
else
  log "docker not found; skipping compose bring-up"
fi

log "starting supervisor via tsx"
exec npx tsx packages/supervisor/src/index.ts
