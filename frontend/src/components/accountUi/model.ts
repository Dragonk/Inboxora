/** Pure presentation helpers. Provider/user labels must never be used as identity. */
export type Translate = (key: string, values?: Record<string, unknown>) => string;
export interface SourceIdentity {
  id: string;
  kind: string;
  label?: string | null;
  labelKey?: string;
  accountId?: string | null;
  identityLabel?: string | null;
}
export interface AccountIdentity { id: string; name?: string | null; email_address?: string | null; color?: string | null }
export interface BookIdentity {
  id: string; name?: string | null; source?: string | null;
  account_id?: string | null; connection_id?: string | null; source_connection_id?: string | null;
  account_email?: string | null; account_name?: string | null; dav_source_id?: string | null; source_label?: string | null; source_url?: string | null; source_username?: string | null; visible?: boolean; read_only?: boolean; contact_count?: number | null;
}
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export function colorValue(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : null;
}
export function effectiveColor(override: unknown, source: unknown, accent: string): string {
  return colorValue(override) ?? colorValue(source) ?? accent;
}
export function readableText(color: string): string {
  if (!HEX_COLOR.test(color)) return 'var(--accent-text, #fff)';
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4));
  const luminance = .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}
export function unique(ids: readonly string[]): string[] { return [...new Set(ids)]; }
export function groupState(ids: readonly string[], selected: readonly string[]) {
  const wanted = new Set(selected); const count = unique(ids).filter(id => wanted.has(id)).length;
  const total = unique(ids).length;
  return { count, total, checked: total > 0 && count === total, mixed: count > 0 && count < total };
}
/** One atomic change; never loop over a callback closing over a stale selection. */
export function selectGroup(selected: readonly string[], ids: readonly string[], enabled: boolean): string[] {
  const members = new Set(ids);
  return enabled ? unique([...selected, ...ids]) : selected.filter(id => !members.has(id));
}
export function reconcileSelection(selected: readonly string[] | null, resources: readonly { id: string; visible?: boolean }[]): string[] {
  const available = new Set(resources.map(resource => resource.id));
  return selected === null ? resources.filter(resource => resource.visible !== false).map(resource => resource.id)
    : unique(selected).filter(id => available.has(id));
}
export function providerLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'google': return 'Google';
    case 'microsoft': return 'Microsoft';
    case 'caldav': return 'CalDAV';
    case 'carddav': case 'dav': return 'CardDAV';
    case 'ical_url': case 'ics': return 'ICS';
    case 'local': return 'Inboxora';
    default: return t('accountUi.otherSource');
  }
}
/** Translate *system* group labels; preserve the user's actual resource names. */
export function sourceLabel(source: SourceIdentity, t: Translate, accounts: readonly AccountIdentity[] = [], contacts = false): string {
  if (source.kind === 'local') return t(contacts ? 'accountUi.localBooks' : 'accountUi.localCalendars');
  if (source.kind === 'system' || source.id === 'system:contacts-birthdays') return t('accountUi.contactDates');
  if (source.labelKey === 'accountUi.subscriptions') return t('accountUi.subscriptions');
  if (source.labelKey === 'accountUi.contactDates') return t('accountUi.contactDates');
  if (source.accountId) {
    const account = accounts.find(item => item.id === source.accountId);
    if (account?.name) return account.name;
  }
  return source.label || providerLabel(source.kind, t);
}
export function bookSourceId(book: BookIdentity): string {
  const kind = book.source === 'dav' ? 'carddav' : book.source ?? 'local';
  if (kind === 'local') return 'local';
  if (kind === 'carddav' && book.dav_source_id) return `carddav:source:${book.dav_source_id}`;
  if (book.account_id) return `${kind}:account:${book.account_id}`;
  const connection = book.connection_id ?? book.source_connection_id;
  return connection ? `${kind}:connection:${connection}` : `${kind}:book:${book.id}`;
}
export function groupBooks<T extends BookIdentity>(books: readonly T[]) {
  const groups = new Map<string, { id: string; kind: string; accountId: string | null; identityLabel: string | null; label: string | null; books: T[] }>();
  for (const book of books) {
    const id = bookSourceId(book);
    let group = groups.get(id);
    if (!group) {
      group = { id, kind: book.source === 'dav' ? 'carddav' : book.source ?? 'local', accountId: book.account_id ?? null,
        identityLabel: book.account_email ?? book.source_username ?? null, label: book.account_name ?? book.source_label ?? null, books: [] };
      groups.set(id, group);
    }
    group.books.push(book);
  }
  return [...groups.values()];
}
export interface FeatureFacts { enabled?: boolean; authorized?: boolean; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null }
export function featureState(feature: FeatureFacts | null | undefined): 'unknown' | 'off' | 'authorization' | 'failed' | 'pending' | 'ready' {
  if (!feature) return 'unknown';
  if (feature.enabled === false) return 'off';
  if (feature.authorized === false) return 'authorization';
  if (feature.syncErrorCode) return 'failed';
  if (feature.syncPending) return 'pending';
  if (feature.authorized && feature.synchronized) return 'ready';
  return feature.authorized ? 'pending' : 'unknown';
}

/** A 200 response can still report a failed or partial synchronisation. */
export function syncFailed(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (data.ok === false || data.error || (typeof data.state === 'string' && data.state !== 'success')) return true;
  if (Array.isArray(data.errors) && data.errors.length > 0) return true;
  return data.result != null ? syncFailed(data.result) : false;
}
