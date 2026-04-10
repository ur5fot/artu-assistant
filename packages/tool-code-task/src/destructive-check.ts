export interface DestructiveCheck {
  destructive: boolean;
  reason: string;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(delete|remove|drop|rm\s+-rf|truncate|destroy|wipe|purge)\b/i, reason: 'deletion/removal operation' },
  { pattern: /\.env(\b|\.)/, reason: 'touches .env file (secrets)' },
  { pattern: /\b(password|secret|token|api[_-]?key|credentials?)\b/i, reason: 'touches secrets/credentials' },
  { pattern: /\b(migration|schema|alter\s+table|drop\s+table)\b/i, reason: 'database schema change' },
  { pattern: /\b(package\.json|dependencies|downgrade|uninstall)\b/i, reason: 'dependency change' },
  { pattern: /\bgit\s+(push\s+--force|reset\s+--hard|filter-branch|rebase)\b/i, reason: 'git history rewrite' },
  { pattern: /\bCI\/CD\b|\.github\/workflows|deploy/i, reason: 'CI/CD or deployment change' },
  { pattern: /\b(auth|authentication|authorization|bypass|disable.*test)\b/i, reason: 'auth or test bypass' },
  { pattern: /~\/(\.ssh|\.aws|\.config|\.kube)\b/, reason: 'touches home directory secrets' },
  { pattern: /\b(exfiltrate|leak|curl.*\|.*sh|wget.*\|.*sh)\b/i, reason: 'possible exfiltration' },
];

export async function isDestructive(task: string, context?: string): Promise<DestructiveCheck> {
  const combined = `${task}\n${context ?? ''}`;
  for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(combined)) {
      return { destructive: true, reason };
    }
  }
  return { destructive: false, reason: '' };
}
