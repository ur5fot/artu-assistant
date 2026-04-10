#!/bin/bash
# Ensures Docker Desktop is running on macOS, waits for daemon to be ready.
set -e

if docker info >/dev/null 2>&1; then
  echo "Docker is running"
  exit 0
fi

echo "Docker is not running, starting Docker Desktop..."
open -a Docker

# Wait up to 60 seconds for Docker to be ready
for i in {1..60}; do
  if docker info >/dev/null 2>&1; then
    echo "Docker is ready"
    exit 0
  fi
  sleep 1
done

echo "Docker failed to start within 60 seconds" >&2
exit 1
