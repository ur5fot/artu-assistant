# Fix: `code_task` agent doesn't see R2 project context

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `code_task` so the Claude Agent SDK loads full R2 project context via `AGENTS.md` and doesn't break neighboring code when refactoring.

**Architecture:** Add `systemPrompt: { type: 'preset', preset: 'claude_code' }` + `allowedTools` allowlist to the `query()` call in `agent-sdk.ts`. Expand the task prompt to force explore-first and ban destructive git/npm commands. Also add `.claude/settings.json` to `.gitignore`.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk`, Vitest

---

## Background

When a user asks R2 to modify its own code via `code_task`, the Claude Agent SDK runs in an isolated git worktree. Today `agent-sdk.ts` invokes `query()` with only `{ cwd, abortController }` — no `systemPrompt`, no `allowedTools`. As a result:

- The agent never reads `AGENTS.md` at the worktree root (which is 403 lines of full R2 architecture overview).
- The agent has no model of what R2 is, what packages exist, or where to find files.
- When asked "add dark/light theme toggle", the agent either completed in 0s with zero files changed ("could not find where to apply changes"), or it later refactored neighboring files and dropped existing props (destructiveWarning, isCodeTask 3-button UI) because it had no awareness of Phase 3C code_task confirmation flow.

SDK types in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1460-1462` confirm:

```typescript
systemPrompt?: string | {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
  excludeDynamicSections?: boolean;
};
```

The `preset: 'claude_code'` option makes the SDK auto-load `AGENTS.md` / `CLAUDE.md` from `cwd` and apply the full Claude Code system prompt (tool descriptions, file operation semantics, project awareness).

---

### Task 1: Update `agent-sdk.ts` with systemPrompt preset and allowedTools

**Files:**
- Modify: `packages/tool-code-task/src/agent-sdk.ts`

- [x] **Step 1: Read the current file to understand existing structure**

Run: `cat packages/tool-code-task/src/agent-sdk.ts`
Expected: file has `buildPrompt()` and `runAgent()` functions; `query()` is called with `{ prompt, options: { cwd, abortController } }`.

- [x] **Step 2: Replace `buildPrompt` function**

Open `packages/tool-code-task/src/agent-sdk.ts` and replace the `buildPrompt` function (currently around lines 11-16) with:

```typescript
function buildPrompt(task: string, context?: string, cwd?: string): string {
  const parts = [`Task: ${task}`];
  if (context) parts.push(`\nContext: ${context}`);
  parts.push(
    `\nYou are working inside an isolated git worktree of the R2-D2 project itself. ` +
    `Read AGENTS.md in the current directory first to understand the repo layout, packages, and conventions before making changes. ` +
    `Explore relevant files (Glob/Grep/Read) to find existing patterns, then implement the change. ` +
    `When modifying existing components, preserve all existing props and behavior — only add what the task asks for.`,
  );
  parts.push(
    `\nWork in the current directory (${cwd ?? '.'}) only. Make all changes needed to complete the task. ` +
    `Stage changes with \`git add\`. Do NOT run \`git commit\`, \`git push\`, \`git reset\`, \`git checkout\`, or \`git worktree\` — the harness commits staged changes. ` +
    `Do NOT run \`npm install\`, \`pnpm install\`, or any package manager install/update commands. ` +
    `You may run build/test/lint commands to verify your changes.`,
  );
  return parts.join('\n');
}
```

- [x] **Step 3: Update the `query()` call inside `runAgent`**

Find the `query()` invocation (currently `const stream = query({ prompt, options: { cwd: params.workdir, abortController } });`) and replace with:

```typescript
    const stream = query({
      prompt,
      options: {
        cwd: params.workdir,
        abortController,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        allowedTools: [
          'Read',
          'Glob',
          'Grep',
          'Edit',
          'Write',
          'MultiEdit',
          'Bash',
          'TodoWrite',
        ],
      },
    });
```

- [x] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p packages/tool-code-task/tsconfig.json`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add packages/tool-code-task/src/agent-sdk.ts
git commit -m "feat: pass claude_code preset and allowedTools to agent SDK"
```

---

### Task 2: Update tests for new SDK options and prompt

**Files:**
- Modify: `packages/tool-code-task/src/__tests__/agent-sdk.test.ts`

- [x] **Step 1: Read existing test file**

Run: `cat packages/tool-code-task/src/__tests__/agent-sdk.test.ts`
Expected: file has `describe('runAgent')` block with 4 tests. The third test is named `'passes cwd and task to SDK'` and asserts that `mockQuery` was called with `{ prompt, options: { cwd } }`.

- [x] **Step 2: Replace the "passes cwd and task to SDK" test**

Locate the `it('passes cwd and task to SDK', async () => {...})` block and replace it with:

```typescript
  it('passes cwd, task, systemPrompt preset and allowedTools to SDK', async () => {
    async function* gen() { yield { type: 'result' }; }
    mockQuery.mockReturnValueOnce(gen());

    await runAgent({ workdir: '/tmp/r2-dev-y', task: 'do thing', context: 'use X', onProgress: () => {} });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('do thing'),
      options: expect.objectContaining({
        cwd: '/tmp/r2-dev-y',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        allowedTools: expect.arrayContaining(['Read', 'Edit', 'Bash', 'Glob', 'Grep']),
      }),
    }));
    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('use X');
    expect(prompt).toMatch(/AGENTS\.md/);
    expect(prompt).toMatch(/do not.*commit/i);
    expect(prompt).toMatch(/preserve.*existing props/i);
  });
```

- [x] **Step 3: Run the updated test**

Run: `cd packages/tool-code-task && npx vitest run src/__tests__/agent-sdk.test.ts`
Expected: all 4 tests PASS (updated test + 3 unchanged).

- [x] **Step 4: Commit**

```bash
git add packages/tool-code-task/src/__tests__/agent-sdk.test.ts
git commit -m "test: assert systemPrompt preset, allowedTools, and prompt guardrails in runAgent"
```

---

### Task 3: Ignore `.claude/settings.json`

**Files:**
- Modify: `.gitignore`

- [x] **Step 1: Read current `.gitignore`**

Run: `cat .gitignore`
Expected: standard ignore file with `node_modules/`, `data/`, `.env`, `dist/`, `*.db`, `*.enc`, `*.tsbuildinfo`, `.ralphex/progress/`, `.superpowers/`.

- [x] **Step 2: Append the Claude settings entry**

Append to `.gitignore`:

```
# Claude Code local settings (auto-updated by IDE, not meaningful for R2)
.claude/settings.json
```

- [x] **Step 3: Remove the file from git index without deleting it locally**

Run: `git rm --cached .claude/settings.json`
Expected: output `rm '.claude/settings.json'`. The local file stays on disk because of `--cached`.

- [x] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore .claude/settings.json (auto-updated by IDE)"
```

---

### Task 4: Full verification

**Files:**
- All modified files

- [x] **Step 1: Typecheck all packages**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json && npx tsc --noEmit -p packages/supervisor/tsconfig.json && npx tsc --noEmit -p packages/tool-code-task/tsconfig.json && npx tsc --noEmit -p packages/tool-code-deploy/tsconfig.json`
Expected: no type errors.

- [x] **Step 2: Run all tests**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS, including the updated `agent-sdk.test.ts`.

- [x] **Step 3: Confirm final git status is clean**

Run: `git status --short`
Expected: empty output (all changes committed).
