#!/usr/bin/env bash
#
# install-r2-service.sh — generate the R2 supervisor LaunchAgent plist, write it
# to the LaunchAgents directory, and (unless --no-load) register it with launchd.
#
# Configuration via environment:
#   TARGET_DIR   where to write the plist (default ~/Library/LaunchAgents)
#   LABEL        launchd label / plist basename (default com.r2.supervisor)
#   SHELL_PATH   shell that runs the wrapper (default /bin/zsh)
#   LOG_DIR      directory for stdout/stderr logs (default ~/Library/Logs)
#
# Flags:
#   --no-load    only write the plist; do not touch launchctl or the log dir.
#                Used by tests for a side-effect-free dry run.

set -euo pipefail

TARGET_DIR="${TARGET_DIR:-${HOME}/Library/LaunchAgents}"
LABEL="${LABEL:-com.r2.supervisor}"
SHELL_PATH="${SHELL_PATH:-/bin/zsh}"
LOG_DIR="${LOG_DIR:-${HOME}/Library/Logs}"

NO_LOAD=0
for arg in "$@"; do
  case "${arg}" in
    --no-load) NO_LOAD=1 ;;
    -h | --help)
      # Print the leading comment block as help text.
      # shellcheck disable=SC2001
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'error: unknown argument %q\n' "${arg}" >&2
      exit 1
      ;;
  esac
done

log() {
  printf '[install-r2-service] %s\n' "$*" >&2
}

# Resolve repo root and the generator path from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
GENERATOR="${SCRIPT_DIR}/gen-r2-launchd-plist.mjs"
WRAPPER="${SCRIPT_DIR}/r2-service.sh"

OUT_LOG="${LOG_DIR}/r2-supervisor.out.log"
ERR_LOG="${LOG_DIR}/r2-supervisor.err.log"
PLIST_PATH="${TARGET_DIR}/${LABEL}.plist"

mkdir -p "${TARGET_DIR}"

log "generating plist -> ${PLIST_PATH}"
# Env var names must match those read by gen-r2-launchd-plist.mjs main().
REPO_PATH="${REPO_ROOT}" \
  LABEL="${LABEL}" \
  SHELL_PATH="${SHELL_PATH}" \
  WRAPPER_PATH="${WRAPPER}" \
  OUT_LOG="${OUT_LOG}" \
  ERR_LOG="${ERR_LOG}" \
  node "${GENERATOR}" >"${PLIST_PATH}"

if [[ "${NO_LOAD}" -eq 1 ]]; then
  log "--no-load: wrote plist only; launchctl and log dir untouched"
  log "plist: ${PLIST_PATH}"
  exit 0
fi

# Real install: make sure the log directory exists so launchd can open the logs.
mkdir -p "${LOG_DIR}"

# Idempotent reload: unload any previous definition first (ignore errors).
log "unloading any existing service (ignored if absent)"
launchctl unload "${PLIST_PATH}" 2>/dev/null || true

log "loading service"
launchctl load -w "${PLIST_PATH}"

log "installed ${LABEL}"
log "logs: ${OUT_LOG} (stdout), ${ERR_LOG} (stderr)"
log "status: launchctl list | grep ${LABEL}"
