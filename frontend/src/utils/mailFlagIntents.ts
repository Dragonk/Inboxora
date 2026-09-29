import { clearReadGuards } from './pendingReads.ts';
import { getAuthEpoch, onAuthEpochChange } from './authEpoch.ts';
import { mailMutationFailure, mailMutationStatus, type MailMutationStatus } from './mailMutationOutcome.ts';

type Field = 'is_read' | 'is_starred';
type Intent = { version: number; value: boolean; status: MailMutationStatus | 'inflight' | 'reconciled'; epoch: number; observedAt?: number; settledAt?: number; previous?: Intent };
type Row = { id: string; physical_is_read?: boolean; is_read?: boolean; is_starred?: boolean; message_count?: unknown; unread_count?: unknown; category?: unknown; is_archived?: unknown; folder_paths?: unknown; _mailProjectionScope?: unknown; _mailReadbackSequence?: unknown };
type ReadbackTicket = { sequence: number; versions: Map<string, number> };
const intents = new Map<string, Intent>();
let sequence = 0;
let readbackSequence = 0;
const key = (id: string, field: Field) => `${field}:${id}`;
onAuthEpochChange(() => intents.clear());

export function beginMailFlagIntent(id: string, field: Field, value: boolean) {
  const intent: Intent = { version: ++sequence, value, status: 'inflight', epoch: getAuthEpoch(), previous: intents.get(key(id, field)) };
  intents.set(key(id, field), intent);
  return intent.version;
}
export function settleMailFlagIntent(id: string, field: Field, version: number, response: unknown, error = false) {
  const entryKey = key(id, field);
  let intent = intents.get(entryKey);
  while (intent && intent.version !== version) intent = intent.previous;
  if (!intent) return;
  intent.status = error ? mailMutationFailure(response) : mailMutationStatus(response, id);
  intent.settledAt = readbackSequence;
  let current = intents.get(entryKey);
  while (current?.status === 'failed') current = current.previous;
  if (current) intents.set(entryKey, current);
  else intents.delete(entryKey);
}
export function pendingMailFlag(id: string, field: Field) {
  const intent = intents.get(key(id, field));
  return intent && (intent.status === 'inflight' || intent.status === 'pending') ? intent.value : undefined;
}
export function mailFlagReadbackTicket(): ReadbackTicket {
  return { sequence: ++readbackSequence, versions: new Map([...intents]
    .filter(([, value]) => value.status !== 'inflight').map(([id, value]) => [id, value.version])) };
}

/** A later authoritative GET acknowledges a physical flag; older GETs stay fenced. */
export function projectMailFlagIntents<T extends Row>(rows: readonly T[], ticket?: ReadbackTicket): T[] {
  return rows.map(row => {
    let result = row;
    for (const field of ['is_read', 'is_starred'] as const) {
      const id = key(row.id, field);
      const intent = intents.get(id);
      if (!intent) continue;
      const threadRow = Number(row.message_count) > 1;
      // A thread head's aggregate is not the representative copy's own read flag.
      const observed = field === 'is_read' && threadRow ? row.physical_is_read : row[field];
      if (intent.status === 'reconciled') {
        if (!ticket) continue;
        if (ticket.sequence > (intent.observedAt ?? 0) && typeof observed === 'boolean') {
          intent.value = observed;
          intent.observedAt = ticket.sequence;
          continue;
        }
      } else if (ticket?.versions.get(id) === intent.version && typeof observed === 'boolean') {
        // A GET begun after settlement is authoritative even when an uncertain
        // write did not land. Waiting for equality would hide unread mail forever.
        intent.value = observed;
        intent.status = 'reconciled';
        intent.observedAt = ticket.sequence;
        intent.previous = undefined;
        if (field === 'is_read') clearReadGuards(row.id);
        continue;
      }
      if (threadRow && field === 'is_read') {
        result = { ...result, physical_is_read: intent.value };
      } else {
        result = { ...result, [field]: intent.value,
          ...(field === 'is_read' && row.unread_count !== undefined ? { unread_count: intent.value ? 0 : 1 } : {}) };
      }
    }
    return result;
  });
}

type ScopedRow = Row & { account_id?: string; folder?: string };
export function isInboxPhysicalMessage(row: { folder?: unknown; folder_paths?: unknown; is_archived?: unknown }): boolean {
  return row.is_archived !== true && (row.folder === 'INBOX'
    || (Array.isArray(row.folder_paths) && row.folder_paths.includes('INBOX')));
}
export function scopedThreadUnreadCount(row: ScopedRow, children: readonly ScopedRow[]): number {
  const scope = row._mailProjectionScope && typeof row._mailProjectionScope === 'object'
    ? row._mailProjectionScope as { folder?: string; category?: string } : { folder: row.folder };
  return children.filter(child => {
    if (child.account_id !== row.account_id || child.is_read) return false;
    const folder = scope.folder;
    if (folder === 'Archive') {
      if (child.folder !== folder && child.is_archived !== true) return false;
    } else if (folder) {
      if (child.is_archived === true) return false;
      if (child.folder !== folder && !(Array.isArray(child.folder_paths) && child.folder_paths.includes(folder))) return false;
    }
    return !scope.category || (scope.category === 'primary'
      ? !child.category || child.category === 'primary' : child.category === scope.category);
  }).length;
}

/** Keep cached complete thread aggregates stable while individual copies are pending. */
export function projectMailThreadRows<T extends Row & { thread_id?: string; account_id?: string; folder?: string }>(rows: T[], cache: Record<string, readonly ScopedRow[]>): T[] {
  return projectMailFlagIntents(rows).map(row => {
    if (!(Number(row.message_count) > 1)) return row;
    const children = cache[row.thread_id || row.id];
    if (!children || children.length !== Number(row.message_count) || !children.some(child => child.id === row.id)) return row;
    const active = (field: Field) => children.some(child => {
      const intent = intents.get(key(child.id, field));
      if (!intent) return false;
      if (intent.status === 'inflight') return true;
      // A list started after settlement already contains the current aggregate.
      // Its unread child may not be the representative, so retaining that child's
      // cached optimism would hide unread mail despite a successful readback.
      if (typeof row._mailReadbackSequence === 'number') {
        const observedAfter = intent.status === 'reconciled' ? intent.observedAt : intent.settledAt;
        return row._mailReadbackSequence <= (observedAfter ?? 0);
      }
      return intent.status !== 'reconciled';
    });
    if (!active('is_read') && !active('is_starred')) return row;
    const projected = projectMailFlagIntents(children);
    const unread = scopedThreadUnreadCount(row, projected);
    return { ...row,
      ...(active('is_read') ? { unread_count: unread, is_read: unread === 0, physical_is_read: projected.find(child => child.id === row.id)?.is_read } : {}),
      ...(active('is_starred') ? { is_starred: projected.some(child => child.is_starred) } : {}),
    };
  });
}
export function resetMailFlagIntentsForTest() { intents.clear(); }
