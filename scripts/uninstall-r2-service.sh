#!/usr/bin/env bash
#
# uninstall-r2-service.sh — unload the R2 supervisor LaunchAgent and remove its
# plist. Idempotent: succeeds even if the service is not loaded or the plist is
# already gone.
#
# Configuration via environment:
#   TARGET_DIR   where the plist lives (default ~/Library/LaunchAgents)
#   LABEL        launchd label / plist basename (default com.r2.supervisor)

set -euo pipefail

TARGET_DIR="${TARGET_DIR:-${HOME}/Library/LaunchAgents}"
LABEL="${LABEL:-com.r2.supervisor}"
PLIST_PATH="${TARGET_DIR}/${LABEL}.plist"

log() {
  printf '[uninstall-r2-service] %s\n' "$*" >&2
}

if [[ -f "${PLIST_PATH}" ]]; then
  log "unloading service"
  launchctl unload -w "${PLIST_PATH}" 2>/dev/null || true
  log "removing ${PLIST_PATH}"
  rm -f "${PLIST_PATH}"
  log "uninstalled ${LABEL}"
else
  log "no plist at ${PLIST_PATH}; nothing to uninstall"
fi
