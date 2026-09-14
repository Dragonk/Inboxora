import { toAppError } from '../utils/errors.ts';
import type { GtdThread } from './gtd.ts';
import {
  clearGtdRemovalGuard,
  setCompletedGtdRemoval,
  setPendingGtdRemoval,
} from './pendingGtdRemovals.ts';

/** The fields of the `/gtd/done` response the row action inspects. */
type GtdDoneResult = { ok?: boolean; archiveFailed?: boolean };

/** The store/api callbacks `doneGtdRow` is injected with. */
interface DoneGtdRowDeps {
  gtdDone(id: string, states: string[]): Promise<GtdDoneResult | null | undefined>;
  removeGtdThread(identity: string, states: string[]): unknown;
  restoreGtdThread(snapshot: unknown): void;
  addNotification(notification: { title: string; body: string }): void;
  scheduleGtdSectionsFetch(): void;
  t(key: string): string;
}

export async function doneGtdRow(
  thread: GtdThread & { id: string },
  states: string[],
  {
    gtdDone,
    removeGtdThread,
    restoreGtdThread,
    addNotification,
    scheduleGtdSectionsFetch,
    t,
  }: DoneGtdRowDeps,
): Promise<GtdDoneResult | null | undefined> {
  const identity = thread.message_id || thread.id;
  setPendingGtdRemoval(identity, states);
  const snapshot = removeGtdThread(identity, states);

  try {
    const result = await gtdDone(thread.id, states);
    setCompletedGtdRemoval(identity, states);
    if (result?.archiveFailed) {
      addNotification({ title: t('gtd.doneArchiveFailed'), body: thread.subject || t('common.noSubject') });
    }
    scheduleGtdSectionsFetch();
    return result;
  } catch (err) {
    clearGtdRemovalGuard(identity, states);
    restoreGtdThread(snapshot);
    console.error('GTD done failed:', toAppError(err).message);
    addNotification({ title: t('gtd.doneFailed'), body: thread.subject || t('common.noSubject') });
    scheduleGtdSectionsFetch();
    return null;
  }
}
