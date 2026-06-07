#!/bin/bash
# stdio <-> Streamable HTTP bridge for R2's MCP server.
# Claude Desktop only speaks MCP over stdio, but R2 exposes MCP over
# Streamable HTTP (http://127.0.0.1:${PORT}/mcp). mcp-remote bridges the two:
# it runs as a stdio server and proxies to the HTTP endpoint.
#
# Point Claude Desktop's MCP config at this script (see README "MCP server").
# Requires Node/npx on PATH and R2 running with MCP_ENABLED=true.
set -euo pipefail

exec npx -y mcp-remote "http://127.0.0.1:${PORT:-3001}/mcp"
