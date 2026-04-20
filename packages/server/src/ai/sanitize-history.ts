import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

// Conversation history is a strong priming signal: the model treats past
// assistant turns as stylistic examples and tends to reproduce their
// formatting (markdown tables, SCREAMING headers, etc.) even when the
// system prompt forbids it. Deleting bad turns from the DB is not a
// sustainable fix — any future style change would require another purge.
//
// Instead, we strip style-only artifacts from past assistant content
// before handing the message array to the API. Content stays intact
// (numbers, dates, names remain readable), only the rendering layer is
// normalized. Extend the transforms here rather than cleaning the DB.

// Matches a markdown table separator row like "|---|:---:|---|".
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*(?::?-+:?[\s:|-]*)+\|?\s*$/;

// Matches any row of a pipe table, including the leading/trailing pipes.
const TABLE_ROW_RE = /^\s*\|.+\|\s*$/;

function flattenPipeTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (TABLE_SEPARATOR_RE.test(line) && line.includes('|')) {
      // Drop header separator; it only exists to render tables.
      continue;
    }
    if (TABLE_ROW_RE.test(line)) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      if (cells.length >= 2) {
        out.push(cells.join(' · '));
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function sanitizeAssistantContent(content: string): string {
  return flattenPipeTables(content);
}

function sanitizeBlock(block: unknown): unknown {
  if (
    block &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: unknown }).type === 'text' &&
    'text' in block &&
    typeof (block as { text: unknown }).text === 'string'
  ) {
    return { ...(block as object), text: sanitizeAssistantContent((block as { text: string }).text) };
  }
  return block;
}

export function sanitizeHistory(messages: MessageParam[]): MessageParam[] {
  return messages.map((m, idx) => {
    if (m.role !== 'assistant') return m;
    // Keep the latest turn untouched — there is no "latest assistant" at the
    // tail in a well-formed request (the last turn is the user's current
    // message), but guard defensively.
    if (idx === messages.length - 1) return m;
    if (typeof m.content === 'string') {
      const sanitized = sanitizeAssistantContent(m.content);
      if (sanitized === m.content) return m;
      return { ...m, content: sanitized };
    }
    if (Array.isArray(m.content)) {
      return { ...m, content: m.content.map(sanitizeBlock) as typeof m.content };
    }
    return m;
  });
}
