# Phase 2A: Audit Log + Tool Auto-Discovery

## Goal

Add SQLite-based audit logging for every tool call and automatic tool discovery at server startup. These are infrastructure features that support future Phase 2 work (permissions, new tools).

## Audit Log

### Database

- **Library:** `better-sqlite3` (synchronous, no event loop blocking for simple inserts)
- **Location:** `data/r2.db` (path from `DB_PATH` env var, default `./data/r2.db`)
- **Module:** `packages/server/src/db.ts` — single connection, initialized at server startup

### Schema

```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Logging

- **Where:** `packages/server/src/ai/tool-loop.ts`
- **When:** After every `tool.handler()` call completes (success or error)
- **What:** tool name, JSON-serialized input, JSON-serialized result, success boolean, execution duration in ms
- **How:** Wrap handler execution with timing, call `logToolCall()` from `db.ts`

### Cleanup

- **When:** At server startup, after table creation
- **Strategy:** Two conditions, both applied:
  1. Delete records older than 30 days
  2. If more than 10,000 records remain, keep only the latest 10,000

```sql
DELETE FROM audit_log WHERE created_at < datetime('now', '-30 days');

DELETE FROM audit_log WHERE id NOT IN (
  SELECT id FROM audit_log ORDER BY id DESC LIMIT 10000
);
```

## Tool Auto-Discovery

### Mechanism

- **Where:** New function `discoverTools()` in `packages/server/src/tools/registry.ts`
- **Called from:** `packages/server/src/index.ts` at startup (replaces manual registration)

### How It Works

1. Read `packages/` directory with `fs.readdirSync`
2. Filter entries matching `tool-*` pattern
3. For each: `await import(\`@r2/tool-${name}\`)` where name is the part after `tool-`
4. Register `module.default` into the registry
5. Log each discovered tool to console

### Error Handling

- If a tool fails to import: log error, skip it, continue with remaining tools
- Server never crashes due to a broken tool package
- Log count of successfully loaded tools at the end

### Changes to Existing Code

- Remove manual `import webSearchTool` and `registry.register(webSearchTool)` from `index.ts`
- Remove `@r2/tool-web-search` from server's `package.json` dependencies (discovered dynamically)
- `discoverTools()` returns the populated registry

## What Is NOT In Scope

- API endpoint for reading audit log (future: Phase 3 history UI)
- Audit log rotation beyond startup cleanup
- Logging Claude API requests or token usage
- UI for viewing audit entries
- Configurable cleanup thresholds (hardcoded 30 days / 10,000 records)

## Dependencies

### New

- `better-sqlite3` + `@types/better-sqlite3` in server package

### Env Variables

- `DB_PATH` — path to SQLite database file (default: `./data/r2.db`)
  - Already listed in AGENTS.md `.env.example`, not yet used

## Testing

### Audit Log (`db.test.ts`)

- `initDb()` creates audit_log table
- `logToolCall()` inserts a record with correct fields
- `cleanupAuditLog()` deletes records older than 30 days
- `cleanupAuditLog()` keeps only latest 10,000 when over limit

### Auto-Discovery (`registry.test.ts`)

- `discoverTools()` finds and registers tools from `packages/tool-*`
- `discoverTools()` skips broken tool packages without crashing
- `discoverTools()` returns empty registry when no tool packages exist

### Integration

- Tool loop writes audit log entry after tool execution
- Audit log entry contains correct duration_ms (> 0)
