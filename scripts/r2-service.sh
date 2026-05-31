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
#   4. Refuse to start if the worker port is already taken (likely `npm run dev`),
#      to avoid two workers fighting over the port.
#   5. exec the supervisor via tsx so deploys (git pull master) are picked up
#      without a build step.

set -euo pipefail

log() {
  printf '[r2-service] %s\n' "$*" >&2
}

# Resolve the repo root from this script's location (scripts/ is one level down)
# so the wrapper works regardless of the launchd working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Worker (server) port. The supervisor forks the worker which binds process.env.PORT
# (packages/server/src/index.ts, default 3001). Mirror that resolution here so the
# conflict guard tracks the real port: prefer an exported PORT, else read it from
# the repo .env, else fall back to 3001 (the .env.example default).
# R2_SERVICE_ENV_FILE overrides the .env path (tests point it at a fixture so they
# don't depend on the developer's gitignored .env).
ENV_FILE="${R2_SERVICE_ENV_FILE:-${REPO_ROOT}/.env}"
WORKER_PORT="${PORT:-}"
if [ -z "${WORKER_PORT}" ] && [ -f "${ENV_FILE}" ]; then
  # Take the last PORT= line, then strip an inline `# comment`, surrounding
  # whitespace and quotes so e.g. `PORT="3004"  # api` still resolves to 3004.
  WORKER_PORT="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  WORKER_PORT="${WORKER_PORT%%#*}"
  WORKER_PORT="$(printf '%s' "${WORKER_PORT}" | tr -d "[:space:]\"'")"
fi
WORKER_PORT="${WORKER_PORT:-3001}"

# node must be on PATH at a version tsx accepts. launchd invokes us via
# `zsh -lc`, a NON-interactive login shell that does NOT source ~/.zshrc — which
# is where nvm (and therefore the right node) lives. Without help the shell falls
# back to a stale system node (e.g. v16), tsx requires >=18, and the supervisor
# crashloops invisibly. So source nvm here, independent of shell interactivity.
export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh" >/dev/null 2>&1 || true
  nvm use --silent default >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  log "error: 'node' not found on PATH; ensure nvm is installed or node is on PATH"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  log "error: node $(node --version) is too old; tsx requires >=18 (check nvm default)"
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
else
  log "warning: 'lsof' not found; cannot verify port ${WORKER_PORT} is free — starting anyway"
fi

# Best-effort Docker bring-up. Never fatal: code-task tools want it, but the
# supervisor and worker run fine without it.
if command -v docker >/dev/null 2>&1; then
  log "bringing up docker compose services (best-effort)"
  docker compose up -d || log "warning: 'docker compose up -d' failed; continuing"
else
  log "docker not found; skipping compose bring-up"
fi

# Test hook: skip the real exec so the wrapper's guards/best-effort logic can be
# exercised without launching the supervisor.
if [ -n "${R2_SERVICE_NO_EXEC:-}" ]; then
  log "R2_SERVICE_NO_EXEC set; skipping supervisor exec (test mode)"
  exit 0
fi

log "starting supervisor via tsx"
exec npx tsx packages/supervisor/src/index.ts
