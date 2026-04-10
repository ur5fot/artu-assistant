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
  parts.push(`\nWork in the current directory (${cwd ?? '.'}) only. Make all changes needed to complete the task. Stage changes with git add. Do not commit — the harness will commit staged changes.`);
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
  const prompt = buildPrompt(params.task, params.context, params.workdir);

  const stream = query({
    prompt,
    options: { cwd: params.workdir },
  });

  for await (const message of stream) {
    if (params.signal?.aborted) break;
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
}
