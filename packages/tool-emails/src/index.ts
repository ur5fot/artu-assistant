import type { ToolDefinition } from '@r2/shared';
import type { EmailStoreLike, ImapClientLike } from './types.js';

export type { EmailStoreLike, ImapClientLike } from './types.js';

interface Deps {
  emailStore: EmailStoreLike | null;
  imapClient: ImapClientLike | null;
}

export function createTool(_deps: Deps): ToolDefinition[] {
  return [];
}

export default createTool;
