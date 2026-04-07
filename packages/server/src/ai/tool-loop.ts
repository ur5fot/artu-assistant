import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import { toClaudeTool } from '../tools/base.js';

const MAX_ITERATIONS = 10;

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
}

export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
}: ToolLoopParams): Promise<void> {
  const tools: Tool[] = registry.getAll().map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.sendMessage({
      messages: currentMessages,
      tools,
    });

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    // Emit text
    for (const block of textBlocks) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }

    // No tool calls — done
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      break;
    }

    // Execute tools and collect results
    const toolResultContents: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;

      const toolCall: ToolCall = {
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        status: 'running',
      };
      onEvent({ type: 'tool_call_start', toolCall });

      const toolDef = registry.get(block.name);
      let result;

      if (toolDef) {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      } else {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      }

      onEvent({ type: 'tool_call_result', id: block.id, result });

      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.success ? result.data : result.error) ?? '',
      });
    }

    // Continue conversation with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultContents },
    ];
  }

  // If we hit max iterations without Claude giving a final text answer, ask it to wrap up
  const lastResponse = currentMessages[currentMessages.length - 1];
  const endedWithToolUse = lastResponse && 'content' in lastResponse && Array.isArray(lastResponse.content);
  if (iterations >= MAX_ITERATIONS && endedWithToolUse) {
    const finalResponse = await client.sendMessage({
      messages: [
        ...currentMessages,
        { role: 'user', content: 'Max tool iterations reached. Give a final answer now.' },
      ],
      tools: [],
    });

    for (const block of finalResponse.content) {
      if (block.type === 'text') {
        onEvent({ type: 'text_delta', content: block.text });
      }
    }
  }

  onEvent({ type: 'done' });
}
