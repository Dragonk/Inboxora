import React from 'react';
import { Button, Dialog } from './ui.tsx';
import ContactsDavSource from './ContactsDavSource.tsx';

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
  border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', marginBottom: 10,
};
const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
const metaStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', margin: '2px 0' };

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
  const summary = provider === 'google' ? props.googleSummary : provider === 'microsoft' ? props.microsoftSummary : null;

  // A provider collection is not a local address book: it cannot be renamed or deleted here, and its delete
  // must never be offered as if it were local.
  const isLocal = selected?.source === 'local';
  const canDelete = props.canDelete && isLocal && localBooks.length > 1;

  const list = (
    <div data-testid="contacts-manager-books" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {books.map(book => {
        const active = book.id === selectedBookId;
        const bookProvider = book.source === 'microsoft' ? 'microsoft' : book.source === 'google' ? 'google' : null;
        const bookSummary = bookProvider === 'google' ? props.googleSummary : bookProvider === 'microsoft' ? props.microsoftSummary : null;
        return (
          <button
            key={book.id}
            type="button"
            data-testid={`contacts-manager-book-${book.id}`}
            data-source={book.source}
            data-visible={book.visible ? 'true' : 'false'}
            data-readonly={book.readOnly ? 'true' : 'false'}
            aria-pressed={active}
            onClick={() => { props.onSelectBook(book.id); if (isMobile) setMobileDetail(true); }}
            style={{
              textAlign: 'left', padding: '9px 11px', borderRadius: 9, cursor: 'pointer',
              background: active ? 'var(--bg-elevated)' : 'transparent',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              color: 'var(--text-primary)', minWidth: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{book.name}</span>
              {!book.visible && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('contacts.booksManager.hiddenBadge')}</span>}
            </div>
            <div style={metaStyle}>
              {t(sourceLabelKey(book.source))} · {book.readOnly ? t('contacts.booksManager.readOnly') : t('contacts.booksManager.readWrite')}
              {book.contactCount !== null ? ` · ${t('contacts.booksManager.contactsCount', { count: book.contactCount })}` : ''}
            </div>
            {bookSummary && <div data-testid={`contacts-manager-book-status-${book.id}`} style={{ ...metaStyle, margin: 0 }}>{t(bookSummary.key ?? 'contacts.addressBooks.lastSynced', bookSummary.values)}</div>}
          </button>
        );
      })}
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
      <h4 style={{ margin: '0 0 10px', fontSize: 14 }}>{selected.name}</h4>

      <div data-testid="contacts-manager-general" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.general')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.nameLabel')}: {selected.name}</p>
        <p style={metaStyle}>{t('contacts.booksManager.sourceLabel')}: {t(sourceLabelKey(selected.source))}</p>
        <p style={metaStyle}>{t('contacts.booksManager.visibility')}: {selected.visible ? t('contacts.booksManager.visible') : t('contacts.booksManager.hidden')}</p>
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
            <Button data-testid={`contacts-manager-sync-${syncTarget}`} disabled={props.syncing !== null} onClick={() => props.onSync(syncTarget)}>
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

      {/* The CardDAV source is managed here, beside the books it pulls — the same place a calendar's sources
          are managed from the calendar screen, and not an installation setting. */}
      <div data-testid="contacts-manager-sources" style={sectionStyle}>
        <p style={sectionTitleStyle}>{t('contacts.booksManager.sources')}</p>
        <p style={metaStyle}>{t('contacts.booksManager.sourcesHint')}</p>
        <ContactsDavSource t={t} />
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
    <Dialog
      title={t('contacts.booksManager.title')}
      closeLabel={t('common.close')}
      onClose={props.onClose}
      testId="contacts-books-manager"
      {...(isMobile ? { className: 'ui-sheet' } : {})}
      footer={<Button onClick={props.onClose}>{t('common.close')}</Button>}
    >
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', minWidth: 0 }}>
        <div data-testid="contacts-manager-list-pane" style={{
          flex: isMobile ? '1 1 100%' : '1 1 260px', minWidth: 0,
          display: isMobile && mobileDetail ? 'none' : 'block',
        }}>
          <div style={rowStyle} data-testid="contacts-manager-create">
            <Button data-testid="contacts-manager-create-book" variant="primary" onClick={props.onCreate}>{t('contacts.addressBooks.create')}</Button>
          </div>
          <div style={{ marginTop: 8 }}>{list}</div>
        </div>
        <div style={{
          flex: isMobile ? '1 1 100%' : '2 1 340px', minWidth: 0,
          display: isMobile && !mobileDetail ? 'none' : 'block',
        }}>
          {detail}
        </div>
      </div>
    </Dialog>
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
