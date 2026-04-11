export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

const TRIGGER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bI\s+(need|cannot|can'?t)\b[^.]*?\b(tool|search|code|file|access)/i, reason: 'requires tool (english)' },
  { pattern: /\blet\s+me\s+(search|look\s+up|find)\b/i, reason: 'requires tool (english)' },
  { pattern: /(не\s+могу|нужно|должен)[^.]*?(поиск|инструмент|tool|доступ)/i, reason: 'requires tool (russian)' },
  { pattern: /\[need\s+(search|code|file|tool)\]/i, reason: 'bracket marker' },
];

export function shouldEscalate(text: string): EscalationDecision {
  const trimmed = (text || '').trim();
  if (trimmed.length === 0) {
    return { escalate: true, reason: 'empty response' };
  }

  for (const { pattern, reason } of TRIGGER_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { escalate: true, reason };
    }
  }

  return { escalate: false, reason: '' };
}
