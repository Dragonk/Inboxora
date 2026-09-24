import React from 'react';
import { Button } from './ui.tsx';
import ContactsDavSource from './ContactsDavSource.tsx';
import { groupBooksByConnection } from './contactsManagementModel.ts';

/**
 * The address-book manager: one panel, the books on the left and the selected book's settings on the right.
 *
 * This replaces the `⋯` menu that held a dozen unrelated actions. A menu is the wrong shape for this: the
 * actions belong to a *specific* book (its visibility, its write-back, its DAV sharing, its delete), and a user
 * cannot tell which book a menu applies to. The calendar settings solved the same problem with a panel, so the
 * concepts — source access, user access, DAV mode, write-back — are named and laid out the same way here.
 *
 * Provider authorization is deliberately absent: connecting Google or Microsoft contacts is account-scoped and
 * lives on the mailbox card in Settings → Accounts. This panel only synchronises books the account is already
 * authorized for, and says so in words when it is not.
 */

export interface ManagerBook {
  id: string;
  name: string;
  source: string;
  visible: boolean;
  readOnly: boolean;
  /** The collection this book belongs to, when the provider owns it. */
  collectionId: string | null;
  /** Mailbox account owning this provider projection; absent for local/DAV books. */
  accountLabel: string | null;
  accountId: string | null;
  connectionId: string | null;
  canSyncProvider: boolean;
  contactCount: number | null;
  syncStatus: { key: string | null; values: Record<string, string> } | null;
}

export interface ManagerProviderState {
  configured: boolean;
  connected: boolean;
}

export interface ContactsBooksManagerProps {
  open: boolean;
  onClose: () => void;
  books: readonly ManagerBook[];
  selectedBookId: string;
  onSelectBook: (id: string) => void;
  isMobile: boolean;
  t: (key: string, values?: Record<string, unknown>) => string;
  onCreate: () => void;
  onRename: (book: ManagerBook) => void;
  onToggleVisibility: () => void;
  onToggleWriteBack: () => void;
  writingBack: boolean;
  /** Delete is only offered where it is allowed; the caller decides that, not this panel. */
  canDelete: boolean;
  onDelete: () => void;
  deleting: boolean;
  deleteError: string | null;
  google: ManagerProviderState;
  microsoft: ManagerProviderState;
  /** The CardDAV source's own state: a DAV book is synchronised by it, not by a provider (DAV-05). */
  dav: ManagerProviderState;
  /**
   * The DAV source changed what it holds (connected, synchronised, disconnected), so the caller reloads the
   * books instead of leaving a stale list on screen (DAV-01).
   */
  onDavChanged: () => void | Promise<void>;
  syncing: 'google' | 'microsoft' | 'dav' | null;
  onSync: (provider: 'google' | 'microsoft' | 'dav') => void;
  googleSummary: { key: string | null; values: Record<string, string> } | null;
  microsoftSummary: { key: string | null; values: Record<string, string> } | null;
  onImportGoogleCsv: () => void;
  onImportVCard: () => void;
  exportUrl: (format: string) => string;
  davMode: 'off' | 'read_only' | 'read_write';
  onDavModeChange: (mode: 'off' | 'read_only' | 'read_write') => void;
  davBusy: boolean;
}

const sourceLabelKey = (source: string): string => {
  if (source === 'google') return 'contacts.booksManager.sourceGoogle';
  if (source === 'microsoft') return 'contacts.booksManager.sourceMicrosoft';
  if (source === 'carddav' || source === 'dav') return 'contacts.booksManager.sourceDav';
  return 'contacts.booksManager.sourceLocal';
};

const sectionStyle: React.CSSProperties = {
  display: 'grid', gap: 10, border: '1px solid var(--border-subtle, var(--border))', borderRadius: 12,
  padding: '15px 16px', marginBottom: 12, background: 'var(--bg-elevated)', boxShadow: '0 1px 2px rgba(0, 0, 0, 0.03)',
};
const sectionTitleStyle: React.CSSProperties = {
  margin: 0, fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.055em',
};
const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
const metaStyle: React.CSSProperties = { fontSize: 12, lineHeight: 1.45, color: 'var(--text-tertiary)', margin: 0 };

export default function ContactsBooksManager(props: ContactsBooksManagerProps) {
  const { t, books, selectedBookId, isMobile } = props;
  const [mobileDetail, setMobileDetail] = React.useState(false);
  // The panel exists only while it is open. Rendering the dialog unconditionally left it visible after
  // `onClose` had set the state to closed, which is why the live report was "it opens and cannot be closed":
  // the close action ran, the state changed, and the dialog stayed. The early return is what makes every
  // close path — the X, Escape, the backdrop and the mobile Back action — actually dismiss it.
  if (!props.open) return null;
  const selected = books.find(book => book.id === selectedBookId) ?? null;
  const localBooks = books.filter(book => book.source === 'local');
  const provider = selected ? (selected.source === 'microsoft' ? 'microsoft' : selected.source === 'google' ? 'google' : null) : null;
  const providerState = provider === 'google' ? props.google : provider === 'microsoft' ? props.microsoft : null;
  const isDavBook = selected?.source === 'carddav' || selected?.source === 'dav';
  // A DAV book is synchronised by its own source; a provider book by its provider. Only a connected target is
  // offered, so the button never promises a run that cannot happen (DAV-05).
  const syncTarget: 'google' | 'microsoft' | 'dav' | null = isDavBook
    ? (props.dav.connected ? 'dav' : null)
    : (providerState?.connected && provider ? provider : null);
  const summary = selected?.syncStatus ?? null;

  // A provider collection is not a local address book: it cannot be renamed or deleted here, and its delete
  // must never be offered as if it were local.
  const isLocal = selected?.source === 'local';
  const canDelete = props.canDelete && isLocal && localBooks.length > 1;

  const list = (
    <div data-testid="contacts-manager-books" style={{ display: 'grid', gap: 12, minWidth: 0 }}>
      {groupBooksByConnection(books).map(group => <section key={group.id} data-testid="contacts-manager-book-group" style={{
        display: 'grid', gap: 4, overflow: 'hidden', border: '1px solid var(--border-subtle, var(--border))',
        borderRadius: 12, background: 'var(--bg-elevated)',
      }}>
        <div data-testid="contacts-manager-book-group-heading" style={{ padding: '11px 13px 8px', borderBottom: '1px solid var(--border-subtle, var(--border))' }}>
          <strong style={{ display: 'block', fontSize: 13, color: 'var(--text-primary)' }}>{t(sourceLabelKey(group.source))}</strong>
          {group.accountLabel && <span style={metaStyle}>{group.accountLabel}</span>}
        </div>
        <div style={{ display: 'grid', gap: 2, padding: 4 }}>
          {group.books.map(book => {
            const active = book.id === selectedBookId;
            const bookSummary = book.syncStatus;
            return <button
              key={book.id}
              type="button"
              data-testid={`contacts-manager-book-${book.id}`}
              data-source={book.source}
              data-visible={book.visible ? 'true' : 'false'}
              data-readonly={book.readOnly ? 'true' : 'false'}
              aria-pressed={active}
              onClick={() => { props.onSelectBook(book.id); if (isMobile) setMobileDetail(true); }}
              style={{
                display: 'grid', gap: 3, width: '100%', textAlign: 'left', padding: '10px 9px', borderRadius: 8, cursor: 'pointer',
                background: active ? 'var(--bg-hover, var(--bg-secondary))' : 'transparent',
                border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`, color: 'var(--text-primary)', minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
                <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book.name}</span>
                {!book.visible && <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--text-tertiary)' }}>{t('contacts.booksManager.hiddenBadge')}</span>}
              </div>
              <div style={metaStyle}>{book.readOnly ? t('contacts.booksManager.readOnly') : t('contacts.booksManager.readWrite')}{book.contactCount !== null ? ` · ${t('contacts.booksManager.contactsCount', { count: book.contactCount })}` : ''}</div>
              {bookSummary && <div data-testid={`contacts-manager-book-status-${book.id}`} style={metaStyle}>{t(bookSummary.key ?? 'contacts.addressBooks.lastSynced', bookSummary.values)}</div>}
            </button>;
          })}
        </div>
      </section>)}
    </div>
  );

  const detail = selected ? (
    <div data-testid="contacts-manager-detail" style={{ minWidth: 0 }}>
      {isMobile && (
        <button type="button" data-testid="contacts-manager-back" onClick={() => setMobileDetail(false)}
          style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', padding: 0, marginBottom: 10, fontSize: 13 }}>
          ← {t('contacts.booksManager.back')}
        </button>
      )}
      <header style={{ display: 'grid', gap: 3, padding: '2px 2px 12px' }}>
        <h4 style={{ margin: 0, fontSize: 18, lineHeight: 1.3, overflowWrap: 'anywhere' }}>{selected.name}</h4>
        <p style={metaStyle}>{t(sourceLabelKey(selected.source))}{selected.accountLabel ? ` · ${selected.accountLabel}` : ''}</p>
      </header>

      <div data-testid="contacts-manager-general" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.general')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, auto) minmax(0, 1fr)', gap: '6px 16px', alignItems: 'baseline' }}>
          <span style={metaStyle}>{t('contacts.booksManager.nameLabel')}</span><strong style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{selected.name}</strong>
          <span style={metaStyle}>{t('contacts.booksManager.sourceLabel')}</span><span style={{ fontSize: 13 }}>{t(sourceLabelKey(selected.source))}</span>
          {selected.accountLabel && <><span style={metaStyle}>{t('contacts.booksManager.accountLabel')}</span><span data-testid="contacts-manager-account" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{selected.accountLabel}</span></>}
          <span style={metaStyle}>{t('contacts.booksManager.visibility')}</span><span style={{ fontSize: 13 }}>{selected.visible ? t('contacts.booksManager.visible') : t('contacts.booksManager.hidden')}</span>
        </div>
        <div style={rowStyle}>
          {isLocal && <Button data-testid="contacts-manager-rename" onClick={() => props.onRename(selected)}>{t('contacts.addressBooks.rename')}</Button>}
          <Button data-testid="contacts-manager-visibility" onClick={props.onToggleVisibility}>
            {selected.visible ? t('contacts.addressBooks.hide') : t('contacts.addressBooks.show')}
          </Button>
        </div>
      </div>

      <div data-testid="contacts-manager-sync" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.sync')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.providerLabel')}: {t(sourceLabelKey(selected.source))}</p>
        {summary
          ? <p style={metaStyle} data-testid="contacts-manager-last-sync">{t(summary.key ?? 'contacts.addressBooks.lastSynced', summary.values)}</p>
          : <p style={metaStyle} data-testid="contacts-manager-last-sync">{t('contacts.booksManager.neverSynced')}</p>}
        {providerState && providerState.configured && !providerState.connected && (
          <p style={metaStyle} data-testid="contacts-manager-connect-hint">
            {t(provider === 'google' ? 'providers.connectGoogleHint' : 'providers.connectMicrosoftHint')}
          </p>
        )}
        <div style={rowStyle}>
          {/* DAV-05: a CardDAV book is synchronised by its own source, so it gets the same action. Which source
              owns it decides the target, never the provider a book merely resembles. */}
          {syncTarget && (
            <Button data-testid={`contacts-manager-sync-${syncTarget}`} disabled={props.syncing !== null || (syncTarget !== 'dav' && !selected.canSyncProvider)} onClick={() => props.onSync(syncTarget)}>
              {props.syncing === syncTarget ? t('contacts.booksManager.syncing') : t('contacts.booksManager.syncNow')}
            </Button>
          )}
        </div>
        <p style={metaStyle}>{t('contacts.booksManager.contactsCount', { count: selected.contactCount ?? 0 })}</p>
      </div>

      <div data-testid="contacts-manager-writeback" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.writeBack')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.sourceAccess')}: {selected.readOnly ? t('contacts.booksManager.readOnly') : t('contacts.booksManager.readWrite')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.userAccess')}: {t('contacts.booksManager.userAccessSource')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.effectiveAccess')}: {selected.readOnly ? t('contacts.booksManager.readOnly') : t('contacts.booksManager.readWrite')}</p>
        {selected.collectionId && (
          <Button data-testid="contacts-manager-write-back" disabled={props.writingBack} onClick={props.onToggleWriteBack}>
            {t(selected.readOnly ? 'calendar.enableWriteBack' : 'calendar.disableWriteBack')}
          </Button>
        )}
      </div>

      <div data-testid="contacts-manager-dav" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.dav')}</p>
        {isLocal ? (
          <label style={{ fontSize: 12 }}>
            {t('calendar.davAccess')}
            <select
              data-testid="contacts-manager-dav-mode"
              value={props.davMode}
              disabled={props.davBusy}
              onChange={event => props.onDavModeChange(event.target.value as 'off' | 'read_only' | 'read_write')}
              style={{ marginLeft: 8 }}
            >
              <option value="off">{t('calendar.davAccessOff')}</option>
              <option value="read_only">{t('calendar.davAccessReadOnly')}</option>
              <option value="read_write">{t('calendar.davAccessReadWrite')}</option>
            </select>
          </label>
        ) : (
          <p style={metaStyle} data-testid="contacts-manager-dav-unavailable">{t('contacts.booksManager.davProviderUnavailable')}</p>
        )}
      </div>

      <div data-testid="contacts-manager-import-export" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.importExport')}</p>
        <div style={rowStyle}>
          {isLocal && <Button data-testid="contacts-manager-import-google" onClick={props.onImportGoogleCsv}>{t('contacts.addressBooks.importGoogle')}</Button>}
          {isLocal && <Button data-testid="contacts-manager-import-vcard" onClick={props.onImportVCard}>{t('contacts.addressBooks.importVCard')}</Button>}
          <a className="ui-button" data-testid="contacts-manager-export-google" href={props.exportUrl('google-csv')}>{t('contacts.addressBooks.exportGoogle')}</a>
          <a className="ui-button" data-testid="contacts-manager-export-outlook" href={props.exportUrl('outlook-csv')}>{t('contacts.addressBooks.exportOutlook')}</a>
          <a className="ui-button" data-testid="contacts-manager-export-vcard" href={props.exportUrl('vcard')}>vCard</a>
        </div>
      </div>

      <div data-testid="contacts-manager-danger" style={{ ...sectionStyle, borderColor: 'var(--red, #f87171)' }}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.dangerZone')}</p>
        {dangerZoneBody(props, canDelete)}
      </div>
    </div>
  ) : (
    <p data-testid="contacts-manager-detail" style={metaStyle}>{t('contacts.booksManager.selectBook')}</p>
  );

  return (
    <section data-testid="contacts-books-manager" aria-label={t('contacts.booksManager.title')} style={{ display: 'grid', gap: 16, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', minWidth: 0 }}>
        <aside data-testid="contacts-manager-list-pane" style={{
          display: isMobile && mobileDetail ? 'none' : 'grid', gap: 12, alignContent: 'start',
          flex: isMobile ? '1 1 100%' : '1 1 260px', minWidth: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div style={{ minWidth: 0 }}>
              <strong style={{ display: 'block', fontSize: 14 }}>{t('contacts.booksManager.title')}</strong>
              <span style={metaStyle}>{t('contacts.booksManager.sourcesHint')}</span>
            </div>
            <div style={rowStyle} data-testid="contacts-manager-create">
              <Button data-testid="contacts-manager-create-book" variant="primary" onClick={props.onCreate}>{t('contacts.addressBooks.create')}</Button>
            </div>
          </div>
          {list}
        </aside>
        <main style={{
          flex: isMobile ? '1 1 100%' : '2 1 340px', minWidth: 0,
          display: isMobile && !mobileDetail ? 'none' : 'block',
        }}>
          {detail}
        </main>
      </div>
      {/* Sources are connection-level controls, not properties of whichever book
          happened to be selected. Keeping CardDAV here prevents a Google or
          Microsoft book from appearing to own the CardDAV credentials. */}
      <div data-testid="contacts-manager-sources" style={{ ...sectionStyle, margin: 0 }}>
        <div style={{ display: 'grid', gap: 3 }}>
          <p style={sectionTitleStyle}>{t('contacts.booksManager.sources')}</p>
          <p style={metaStyle}>{t('contacts.booksManager.sourcesHint')}</p>
        </div>
        <ContactsDavSource t={t} onChanged={props.onDavChanged} />
      </div>
    </section>
  );
}

/** The danger zone body: why delete is unavailable, or the action and its error. */
function dangerZoneBody(props: ContactsBooksManagerProps, canDelete: boolean): React.ReactNode {
  if (!canDelete) {
    return <p data-testid="contacts-manager-delete-blocked" style={metaStyle}>{props.t('contacts.booksManager.deleteNotAllowed')}</p>;
  }
  return (
    <>
      {props.deleteError && <div role="alert" className="ui-alert">{props.deleteError}</div>}
      <Button data-testid="contacts-manager-delete" disabled={props.deleting} onClick={props.onDelete}>
        {props.t(props.deleting ? 'common.saving' : 'contacts.booksManager.deleteBook')}
      </Button>
    </>
  );
}
