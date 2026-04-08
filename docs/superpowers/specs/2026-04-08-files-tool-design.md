# Phase 2B: Files Tool

## Goal

Add file operations tool package (`@r2/tool-files`) that gives R2 the ability to read, write, list, delete, and move files within a configurable root directory. Includes permission level enforcement in the tool loop.

## Operations

| Operation | Tool Name | Description | Permission | Parameters |
|-----------|-----------|-------------|-----------|------------|
| Read | `file_read` | Read text file content | auto | `path` (string, required) |
| Write | `file_write` | Write/create text file | confirm | `path` (string, required), `content` (string, required) |
| List | `file_list` | List directory contents | auto | `path` (string, optional, default: "."), `recursive` (boolean, optional, default: false) |
| Delete | `file_delete` | Delete a file | confirm | `path` (string, required) |
| Move | `file_move` | Move/rename a file | confirm | `source` (string, required), `destination` (string, required) |

## Security

### Root Directory

- **Env var:** `R2_FILES_ROOT`
- **Default:** `~/Documents/r2`
- If root doesn't exist, create it on first operation.

### Path Traversal Protection

All paths are resolved relative to root and validated:

1. `path.resolve(root, userPath)` to get absolute path
2. Check that resolved path starts with root (after both are resolved)
3. Reject if path escapes root — return `ToolResult { success: false, error: "Path outside allowed directory" }`

### Limits

- `file_list` with `recursive: true` — max 1000 entries. If exceeded, return first 1000 with a message "(truncated, 1000 of N total)".
- `file_read` — max 1MB file size. Reject larger files with error.
- Binary files — not supported. `file_read` returns error for non-text files (detect via null bytes in first 512 bytes).

## Package Structure

```
packages/tool-files/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # exports ToolDefinition[] (array of 5 tools)
│   ├── operations.ts     # implementations: readFile, writeFile, listFiles, deleteFile, moveFile
│   └── paths.ts          # resolveRoot(), safePath() — path validation
└── __tests__/
    ├── operations.test.ts  # tests for each operation
    └── paths.test.ts       # tests for path resolution and traversal protection
```

## Export Convention

`index.ts` exports an **array** of `ToolDefinition[]` as default export. This differs from `tool-web-search` which exports a single `ToolDefinition`.

## Changes to Existing Code

### registry.ts — discoverTools()

Update to handle both single tool and array of tools:

```typescript
const tool = mod.default;
if (Array.isArray(tool)) {
  for (const t of tool) registry.register(t);
} else {
  registry.register(tool);
}
```

### base.ts — ToolDefinition

Add back `permissionLevel` field:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: { ... };
  handler: (...) => Promise<ToolResult>;
}
```

All existing tools must be updated to include `permissionLevel`:
- `tool-web-search`: add `permissionLevel: 'auto'`

### tool-loop.ts — Permission enforcement

Before executing a tool handler, check `permissionLevel`:
- `auto` — execute immediately
- `confirm` — return `ToolResult { success: false, error: "This action requires user confirmation (not yet implemented)" }`
- `forbidden` — return `ToolResult { success: false, error: "This action is forbidden" }`

Note: Actual confirmation UI is Phase 2C. For now, `confirm` tools are blocked with a clear message.

## Dependencies

### New package: @r2/tool-files

```json
{
  "dependencies": {
    "@r2/shared": "*"
  }
}
```

No external dependencies — uses only Node.js built-in `fs`, `path`, `os` modules.

### Env Variables

- `R2_FILES_ROOT` — root directory for file operations (default: `~/Documents/r2`)
  - Add to `.env.example`

## Testing

### paths.test.ts

- `resolveRoot()` returns R2_FILES_ROOT when set
- `resolveRoot()` defaults to ~/Documents/r2
- `safePath()` resolves relative paths within root
- `safePath()` rejects paths that traverse outside root (../)
- `safePath()` rejects absolute paths outside root

### operations.test.ts

- `file_read` reads text file content
- `file_read` returns error for non-existent file
- `file_read` returns error for file > 1MB
- `file_read` returns error for binary file
- `file_write` creates new file with content
- `file_write` creates intermediate directories
- `file_write` overwrites existing file
- `file_list` lists directory contents
- `file_list` returns error for non-existent directory
- `file_list` with recursive: true returns nested files
- `file_list` truncates at 1000 entries
- `file_delete` removes a file
- `file_delete` returns error for non-existent file
- `file_move` moves file to new location
- `file_move` returns error when source doesn't exist
- All operations reject paths outside root

### Integration (existing tests)

- `tool-loop.test.ts` — test that `confirm` permission blocks execution
- `registry.test.ts` — test that array exports are registered correctly

## What Is NOT In Scope

- Permission confirmation dialog in UI (Phase 2C)
- Binary file support
- Documents tool (PDF/DOCX) — separate plan
- Reminder tool — separate plan
