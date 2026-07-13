import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface LocalContextConfig {
  numCtx: number;
  outputReserveTokens: number;
  charsPerToken: number;
  memoryMaxChars: number;
  topicMaxChars: number;
}

export type LocalContextResult =
  | {
      fits: true;
      messages: MessageParam[];
      system: string;
      estimatedPromptTokens: number;
      droppedMessages: number;
    }
  | {
      fits: false;
      reason: string;
      estimatedPromptTokens: number;
    };

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getLocalContextConfig(): LocalContextConfig {
  return {
    numCtx: positiveEnv('OLLAMA_NUM_CTX', 8192),
    outputReserveTokens: positiveEnv('OLLAMA_OUTPUT_RESERVE_TOKENS', 1024),
    charsPerToken: positiveEnv('OLLAMA_CHARS_PER_TOKEN', 2.5),
    memoryMaxChars: positiveEnv('OLLAMA_MEMORY_MAX_CHARS', 3000),
    topicMaxChars: positiveEnv('OLLAMA_TOPIC_MAX_CHARS', 3000),
  };
}

function messageText(message: MessageParam): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');
}

function messageChars(message: MessageParam): number {
  return messageText(message).length + message.role.length + 12;
}

function boundBlock(value: string | null | undefined, maxChars: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  const marker = '\n[context truncated]';
  return trimmed.slice(0, Math.max(0, maxChars - marker.length)).trimEnd() + marker;
}

function contextSection(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

export function buildLocalContext(params: {
  messages: MessageParam[];
  system: string;
  tools?: unknown[];
  memoryPrefix?: string | null;
  topicSummaryPrefix?: string | null;
  config?: LocalContextConfig;
}): LocalContextResult {
  const config = params.config ?? getLocalContextConfig();
  const promptTokenBudget = Math.floor(config.numCtx - config.outputReserveTokens);
  if (promptTokenBudget <= 0) {
    return { fits: false, reason: 'invalid_local_context_budget', estimatedPromptTokens: 0 };
  }

  const promptCharBudget = Math.floor(promptTokenBudget * config.charsPerToken);
  const toolsChars = params.tools?.length ? JSON.stringify(params.tools).length + 24 : 0;
  const baseChars = params.system.length + toolsChars + 32;
  const latest = params.messages.at(-1);
  if (!latest) {
    return { fits: false, reason: 'missing_current_message', estimatedPromptTokens: Math.ceil(baseChars / config.charsPerToken) };
  }

  let requiredStart = params.messages.length - 1;
  for (let i = params.messages.length - 1; i >= 0; i--) {
    if (params.messages[i].role === 'user') {
      requiredStart = i;
      break;
    }
  }
  const requiredMessages = params.messages.slice(requiredStart);
  const requiredChars = requiredMessages.reduce((total, message) => total + messageChars(message), 0);
  if (baseChars + requiredChars > promptCharBudget) {
    return {
      fits: false,
      reason: 'current_message_exceeds_local_context',
      estimatedPromptTokens: Math.ceil((baseChars + requiredChars) / config.charsPerToken),
    };
  }

  let system = params.system;
  let usedChars = baseChars + requiredChars;
  const optionalSections: Array<[string, string | null]> = [
    ['retrieved_memory', boundBlock(params.memoryPrefix, config.memoryMaxChars)],
    ['older_topic_summary', boundBlock(params.topicSummaryPrefix, config.topicMaxChars)],
  ];
  for (const [tag, content] of optionalSections) {
    if (!content) continue;
    const section = contextSection(tag, content);
    if (usedChars + section.length + 2 <= promptCharBudget) {
      system += `\n\n${section}`;
      usedChars += section.length + 2;
    }
  }

  const kept: MessageParam[] = [...requiredMessages];
  for (let i = requiredStart - 1; i >= 0; i--) {
    const cost = messageChars(params.messages[i]);
    if (usedChars + cost > promptCharBudget) break;
    kept.unshift(params.messages[i]);
    usedChars += cost;
  }
  while (kept.length > 1 && kept[0].role === 'assistant') {
    usedChars -= messageChars(kept[0]);
    kept.shift();
  }

  return {
    fits: true,
    messages: kept,
    system,
    estimatedPromptTokens: Math.ceil(usedChars / config.charsPerToken),
    droppedMessages: params.messages.length - kept.length,
  };
}
