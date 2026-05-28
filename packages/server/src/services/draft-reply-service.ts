export interface DraftState {
  pendingId: string;
  originalUid: number;
  accountId: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  body: string;
  // Set after the ephemeral draft message is sent so a modal submit (which
  // arrives as a fresh interaction) can edit the original draft in place.
  messageId: string | null;
}

export interface DraftReplyService {
  put(state: DraftState): void;
  get(id: string): DraftState | null;
  drop(id: string): void;
  has(id: string): boolean;
}

interface Deps {
  pendingDrafts: Map<string, DraftState>;
}

export function createDraftReplyService(deps: Deps): DraftReplyService {
  const { pendingDrafts } = deps;
  return {
    put(state) {
      pendingDrafts.set(state.pendingId, state);
    },
    get(id) {
      return pendingDrafts.get(id) ?? null;
    },
    drop(id) {
      pendingDrafts.delete(id);
    },
    has(id) {
      return pendingDrafts.has(id);
    },
  };
}
