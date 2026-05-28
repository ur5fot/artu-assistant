export interface DraftState {
  pendingId: string;
  originalUid: number;
  accountId: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
  body: string;
  holdTimer?: ReturnType<typeof setTimeout> | null;
  holdSendAt?: number | null;
}

export interface DraftReplyService {
  put(state: DraftState): void;
  get(id: string): DraftState | null;
  drop(id: string): void;
  has(id: string): boolean;
  armHold(id: string, timer: ReturnType<typeof setTimeout>, sendAt: number): void;
  disarmHold(id: string): void;
}

interface Deps {
  pendingDrafts: Map<string, DraftState>;
}

export function createDraftReplyService(deps: Deps): DraftReplyService {
  const { pendingDrafts } = deps;
  return {
    put(state) {
      pendingDrafts.set(state.pendingId, {
        ...state,
        holdTimer: state.holdTimer ?? null,
        holdSendAt: state.holdSendAt ?? null,
      });
    },
    get(id) {
      return pendingDrafts.get(id) ?? null;
    },
    drop(id) {
      const existing = pendingDrafts.get(id);
      if (existing?.holdTimer) {
        clearTimeout(existing.holdTimer);
      }
      pendingDrafts.delete(id);
    },
    has(id) {
      return pendingDrafts.has(id);
    },
    armHold(id, timer, sendAt) {
      const existing = pendingDrafts.get(id);
      if (!existing) return;
      if (existing.holdTimer) {
        clearTimeout(existing.holdTimer);
      }
      existing.holdTimer = timer;
      existing.holdSendAt = sendAt;
    },
    disarmHold(id) {
      const existing = pendingDrafts.get(id);
      if (!existing) return;
      if (existing.holdTimer) {
        clearTimeout(existing.holdTimer);
      }
      existing.holdTimer = null;
      existing.holdSendAt = null;
    },
  };
}
