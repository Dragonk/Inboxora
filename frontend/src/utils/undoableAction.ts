export const UNDO_WINDOW_MS = 4500;
export const UNDO_COMMIT_DELAY_MS = UNDO_WINDOW_MS + 250;

export interface UndoableCommitOptions {
  delayMs?: number;
  commit: () => Promise<void> | void;
  undo: () => void;
  allowUndoWhileCommitting?: boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
}

export function createUndoableCommit({
  delayMs = UNDO_WINDOW_MS,
  commit,
  undo,
  allowUndoWhileCommitting = false,
  schedule = setTimeout,
  cancel = (timer: unknown) => { if (timer != null) clearTimeout(timer as ReturnType<typeof setTimeout>); },
}: UndoableCommitOptions) {
  let state = 'pending';
  const timer = schedule(async () => {
    if (state !== 'pending') return;
    state = 'committing';
    try {
      await commit();
    } finally {
      state = 'committed';
    }
  }, delayMs);

  return {
    undo() {
      if (state !== 'pending' && !(allowUndoWhileCommitting && state === 'committing')) return false;
      state = 'undone';
      cancel(timer);
      undo();
      return true;
    },
  };
}
