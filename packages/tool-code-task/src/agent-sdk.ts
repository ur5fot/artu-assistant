import { query } from '@anthropic-ai/claude-agent-sdk';

export interface AgentRunParams {
  workdir: string;
  task: string;
  context?: string;
  onProgress: (message: string) => void;
  signal?: AbortSignal;
}

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

function describeToolUse(name: string, input: Record<string, unknown>): string {
  if (name === 'Edit' || name === 'Write') {
    return `${name === 'Edit' ? 'Editing' : 'Writing'} ${input.file_path ?? 'file'}`;
  }
  if (name === 'Bash') {
    return `Running: ${String(input.command ?? '').slice(0, 60)}`;
  }
  if (name === 'Read') {
    return `Reading ${input.file_path ?? 'file'}`;
  }
  return `Tool: ${name}`;
}

export async function runAgent(params: AgentRunParams): Promise<void> {
  if (params.signal?.aborted) return;

  const prompt = buildPrompt(params.task, params.context, params.workdir);

  // Forward the caller's AbortSignal into the Agent SDK so that cancelling
  // actually stops the in-flight API call. Without this the SDK continues to
  // stream and burn tokens after the user hits "Stop".
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  params.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const stream = query({
      prompt,
      options: {
        cwd: params.workdir,
        abortController,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: [
          'Read',
          'Glob',
          'Grep',
          'Edit',
          'Write',
          'MultiEdit',
          'Bash',
          'TodoWrite',
        ],
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

    for await (const message of stream) {
      if (abortController.signal.aborted) break;
      if ((message as any).type !== 'assistant') continue;

      const content = (message as any).message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = block.text.trim();
          if (text.length > 0) params.onProgress(text.slice(0, 80));
        } else if (block.type === 'tool_use') {
          params.onProgress(describeToolUse(block.name, block.input ?? {}));
        }
      }
    }
  } catch (err) {
    // If we aborted, swallow the cancellation error — the caller already
    // knows why the run ended.
    if (abortController.signal.aborted) return;
    throw err;
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
  }
}
