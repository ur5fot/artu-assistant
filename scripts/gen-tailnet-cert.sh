#!/bin/bash
# Generate a Tailscale-issued HTTPS cert for this machine's tailnet hostname.
# Writes .tailnet-cert/<host>.crt and .tailnet-cert/<host>.key.
# Override the host by exporting R2_TAILNET_HOST.
set -e

if ! command -v tailscale >/dev/null 2>&1; then
  echo "error: 'tailscale' CLI not found on PATH." >&2
  echo "Install Tailscale and ensure the tailscaled daemon is running." >&2
  exit 1
fi

HOST="${R2_TAILNET_HOST:-}"
if [ -z "$HOST" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: 'jq' not found and R2_TAILNET_HOST is unset." >&2
    echo "Install jq or export R2_TAILNET_HOST=<your-host>.ts.net." >&2
    exit 1
  fi
  HOST=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
fi

if [ -z "$HOST" ] || [ "$HOST" = "null" ]; then
  echo "error: could not resolve tailnet hostname." >&2
  echo "Is Tailscale logged in? Try: tailscale status" >&2
  exit 1
fi

mkdir -p .tailnet-cert
echo "Requesting Tailscale cert for $HOST..."
tailscale cert \
  --cert-file ".tailnet-cert/${HOST}.crt" \
  --key-file ".tailnet-cert/${HOST}.key" \
  "$HOST"

echo "✓ Cert written to .tailnet-cert/${HOST}.crt"
echo "✓ Key  written to .tailnet-cert/${HOST}.key"
echo ""
echo "Next: npm run dev:tailnet"
