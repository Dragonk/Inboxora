import MobileFloatingAction from './MobileFloatingAction.tsx';
import { contactDateLabel, formatContactDate } from '../utils/contactDateLabels.ts';
import { useBackLayer } from '../hooks/useBackNavigation.ts';
import { intlLocale } from '../utils/intlLocale.ts';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../utils/api.ts';
import { useStore } from '../store/index.ts';
import { useMobile } from '../hooks/useMobile.ts';
import { useCompactLayout } from '../hooks/useCompactLayout.ts';
import { Button, Dialog, PanelResizeHandle, inputStyle as sharedInputStyle } from './ui.tsx';
import { MobileModuleHeader, HeaderAction } from './MobileModuleHeader.tsx';
import { beginPanelResize } from '../utils/panelWidth.ts';
import './contacts.css';
import SenderAvatarImage from './SenderAvatarImage.tsx';
import { safeHttpUrl } from '../utils/contactLinks.ts';
import type { CSSProperties } from 'react';
import type { StoreState } from '../store/index.ts';
import { toAppError } from '../utils/errors.ts';
import { providerFailureKey } from '../utils/providerFailure.ts';
import { providerConnectorSummary } from '../utils/providerSyncSummary.ts';
import { accountContactsSyncMessage, groupBooksByConnection, initialContactTarget, providerSyncAccount, writableContactTarget, type AccountContactsSyncResponse } from './contactsManagementModel.ts';
import ContactsBooksManager from './ContactsBooksManager.tsx';

// Deterministic avatar color from a string
function avatarColor(str: string): string {
  const colors = [
    '#6366f1','#8b5cf6','#ec4899','#f43f5e',
    '#f97316','#eab308','#22c55e','#14b8a6',
    '#06b6d4','#3b82f6',
  ];
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return colors[h % colors.length];
}

function Avatar({ name, email, size = 36, hasContactPhoto }: AvatarProps) {
  const label = (name || email || '?').charAt(0).toUpperCase();
  const color  = avatarColor(name || email || '');
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: color + '22', border: `1.5px solid ${color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.44, fontWeight: 600, color,
      flexShrink: 0, userSelect: 'none',
      position: 'relative', overflow: 'hidden',
    }}>
      {label}
      <SenderAvatarImage email={email} hasContactPhoto={hasContactPhoto} />
    </div>
  );
}

/** One editable entry of the contact form's collections. */
type FormEmail = { value: string; type: string; primary: boolean };
type FormPhone = { value: string; type: string };
type FormDate = { value: string; label: string };
type FormTextEntry = { value: string; type: string };
type FormAddress = { type: string; pobox: string; extended: string; street: string; locality: string; region: string; postalCode: string; country: string };

/** The add/edit contact form's state. Collections are also indexed by field name. */
type ContactFormState = {
  displayName: string;
  firstName: string;
  lastName: string;
  emails: FormEmail[];
  phones: FormPhone[];
  organization: string;
  notes: string;
  contactDates: FormDate[];
  title: string;
  role: string;
  nickname: string;
  urls: FormTextEntry[];
  instantMessages: FormTextEntry[];
  categories: string[];
  addresses: FormAddress[];
  [key: string]: unknown;
};

function EmptyEmailForm(): FormEmail[] {
  return [{ value: '', type: 'other', primary: true }];
}

function emptyContact(): ContactFormState {
  return {
    displayName: '',
    firstName: '',
    lastName: '',
    emails: EmptyEmailForm(),
    phones: [],
    organization: '',
    notes: '',
    contactDates: [],
    title: '',
    role: '',
    nickname: '',
    urls: [],
    instantMessages: [],
    categories: [],
    addresses: [],
  };
}

const PAGE_SIZE = 100;

/** A contact row as the contacts API returns it. */
/** The avatar shown for a contact or an address-chip. */
interface AvatarProps { name?: string | null; email?: string | null; size?: number; hasContactPhoto?: boolean | null }

/** The selected contact's detail pane. */
interface ContactDetailProps {
  contact: ContactRow;
  confirmDelete: boolean;
  saving: boolean;
  error: string | null;
  onEdit: () => void;
  onDeleteRequest: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  t: TFunction;
}
interface ContactRow {
  id: string;
  name?: string | null;
  display_name?: string | null;
  primary_email?: string | null;
  organization?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  notes?: string | null;
  emails?: Array<{ value?: string; type?: string; label?: string; primary?: boolean; [key: string]: unknown }>;
  phones?: Array<{ value?: string; type?: string; label?: string; [key: string]: unknown }>;
  contactDates?: Array<{ value?: string; label?: string; [key: string]: unknown }>;
  title?: string | null;
  role?: string | null;
  nickname?: string | null;
  urls?: Array<{ value?: string; type?: string; label?: string; [key: string]: unknown }>;
  instantMessages?: Array<{ value?: string; type?: string; label?: string; [key: string]: unknown }>;
  categories?: string[];
  addresses?: Array<{ value?: string; type?: string; label?: string; [key: string]: unknown }>;
  visible?: boolean;
  has_contact_photo?: boolean | null;
  last_sent?: string | number | null;
  send_count?: number;
  photo_data?: string | null;
  value?: unknown;
  [key: string]: unknown;
}

/** An address book as the contacts API returns it. */
interface AddressBookRow {
  id: string;
  name?: string | null;
  /**
   * The pulled collection this book belongs to, when it has one, and the server's verdict on whether the
   * book currently accepts a write. Both come from the same capability model the calendars use, so the
   * write-back switch is addressed and labelled the same way in both places.
   */
  collection_id?: string | null;
  connection_id?: string | null;
  provider?: 'google' | 'microsoft' | null;
  account_id?: string | null;
  account_email?: string | null;
  read_only?: boolean;
  source?: string | null;
  visible?: boolean;
  [key: string]: unknown;
}

/** The address-book name dialog: null when closed, otherwise the mode and the value
 * being edited. A real dialog rather than window.prompt, so naming a book looks like
 * the rest of the app and can show the server's validation error in place. */
/** The per-address-book DAV sharing mode. */
type AddressBookDavMode = 'off' | 'read_only' | 'read_write';

type BookDialogState =
  | { mode: 'create'; id: null; name: string }
  | { mode: 'rename'; id: string; name: string; davMode: AddressBookDavMode; davEditable: boolean };

function addressBookDavModeOf(value: unknown): AddressBookDavMode {
  return value === 'off' || value === 'read_only' || value === 'read_write' ? value : 'read_write';
}

/** The provider contact status the sync controls read (no credential is exposed). */
interface ProviderContactsStatus {
  configured?: boolean;
  connected?: boolean;
  connections?: number;
  books?: Array<{ addressBookId: string; contactCount?: number; lastSyncedAt?: string | null; lastErrorCode?: string | null; lastErrorAt?: string | null }>;
}


export default function ContactsPage({ isActive = true, settingsOnly = false, settingsSection = 'accounts' }: { isActive?: boolean; settingsOnly?: boolean; settingsSection?: 'accounts' | 'resources' | 'import' }) {
  const { t } = useTranslation();
  const { showContacts, setAdminTab, setShowAdmin, authEpoch } = useStore();
  const bookLoadGeneration = useRef(0);
  useEffect(() => () => { bookLoadGeneration.current++; }, [authEpoch]);
  const openBookSettings = () => { setBooksOpen(false); setAdminTab('contacts'); setShowAdmin(true); };
  const phone = useMobile();
  const [booksOpen, setBooksOpen] = useState(false);
  // The manager replaces the old `⋯` menu: one panel that shows which book every action applies to.
  const [booksManagerOpen, setBooksManagerOpen] = useState(settingsOnly);
  const [deletingBook, setDeletingBook] = useState(false);
  const [bookDeleteError, setBookDeleteError] = useState<string | null>(null);
  const [davBusy, setDavBusy] = useState(false);
  // The address-book name dialog: null when closed, otherwise the mode and the value
  // being edited. A real dialog rather than window.prompt, so naming a book looks like
  // the rest of the app and can show the server's validation error in place.
  const [bookDialog, setBookDialog] = useState<BookDialogState | null>(null);
  const [bookSaving, setBookSaving] = useState(false);
  const [writingBack, setWritingBack] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  // The provider contact pulls: `connected` decides whether a sync action is offered,
  // and the notice reports what the last run of either provider changed.
  const [googleContacts, setGoogleContacts] = useState<ProviderContactsStatus | null>(null);
  const [microsoftContacts, setMicrosoftContacts] = useState<ProviderContactsStatus | null>(null);
  const [providerSyncing, setProviderSyncing] = useState<'google' | 'microsoft' | 'dav' | null>(null);
  const [providerNotice, setProviderNotice] = useState<{ provider: 'google' | 'microsoft' | 'dav'; message: string } | null>(null);
  /** The CardDAV source's own state, so a DAV book shows its real last sync and offers its own action (DAV-05). */
  const [davStatus, setDavStatus] = useState<{ connected?: boolean; lastSyncAt?: string | null; errorCode?: string | null } | null>(null);
  // What the last file import added, so the user gets a confirmation instead of a
  // silent list refresh.
  const [importNotice, setImportNotice] = useState('');
  const isMobile = useCompactLayout();

  const [contacts, setContacts]     = useState<ContactRow[]>([]);
  const [addressBooks, setAddressBooks] = useState<AddressBookRow[]>([]);
  // Display selection is intentionally independent from the write target. An empty array is
  // an explicit empty selection (zero results), never an alias for "all visible".
  const [selectedAddressBookIds, setSelectedAddressBookIds] = useState<string[]>([]);
  const displaySelectionInitialized = useRef(false);
  const [selectedAddressBookId, setSelectedAddressBookId] = useState('');
  // Creating has its own target so changing the list filter cannot silently
  // redirect a contact while the form is open.
  const [newAddressBookId, setNewAddressBookId] = useState('');
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch]         = useState('');
  const [selected, setSelected]     = useState<ContactRow | null>(null); // full contact object
  const [editing, setEditing]       = useState(false);
  const [form, setForm]             = useState(emptyContact());
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [listError, setListError]   = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showNew, setShowNew]       = useState(false);
  // Mobile: 'list' shows the contact list, 'detail' shows contact/form panel
  const [mobilePanel, setMobilePanel] = useState('list');
  const searchTimer                 = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rowRefs                     = useRef(new Map<string, HTMLElement>());
  const selectedRowIdRef            = useRef<string | null>(null);
  const mobileBackButtonRef         = useRef<HTMLButtonElement | null>(null);
  const importInputRef              = useRef<HTMLInputElement | null>(null);
  const importVCardRef              = useRef<HTMLInputElement | null>(null);
  const contactSelectionRequestRef  = useRef(0);
  const listResizeRef               = useRef<(() => void) | null>(null);

  // The contact list resizes with the same shared width the mail list uses, so
  // widening it in Contacts also widens the mail list (and the calendar panels).
  const handleListResizeMouseDown = (event: React.MouseEvent) => {
    listResizeRef.current?.();
    listResizeRef.current = beginPanelResize(event, { edge: 'right' });
  };
  useEffect(() => () => { listResizeRef.current?.(); }, []);

  // A navigation drawer re-entry must not
  // expose a retained contact detail or new-contact form.
  useEffect(() => {
    if (!isMobile) return;
    contactSelectionRequestRef.current += 1;
    if (!isActive) return;
    // Only an explicit in-module back action may restore the activating row.
    // Re-entering via primary navigation must leave focus on that navigation.
    selectedRowIdRef.current = null;
    setMobilePanel('list');
    setSelected(null);
    setShowNew(false);
    setEditing(false);
    setError(null);
  }, [isActive, isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (mobilePanel === 'detail' && selected) {
      mobileBackButtonRef.current?.focus();
      return;
    }
    if (mobilePanel === 'list' && selectedRowIdRef.current) {
      const row = rowRefs.current.get(selectedRowIdRef.current);
      if (row) {
        row.focus();
        selectedRowIdRef.current = null;
      }
    }
  }, [contacts, isMobile, mobilePanel, selected]);

  // Stable refs used inside scroll handler to avoid stale closures.
  const contactsRef    = useRef<ContactRow[]>([]);
  const totalRef       = useRef(0);
  const loadingMoreRef = useRef(false);
  const searchRef      = useRef('');
  const listRequestRef = useRef(0);
  const contactBookFilter = useMemo(() => displaySelectionInitialized.current
    ? { addressBookIds: selectedAddressBookIds }
    : { addressBookId: selectedAddressBookId || undefined }, [selectedAddressBookId, selectedAddressBookIds]);

  useEffect(() => { contactsRef.current = contacts; }, [contacts]);
  // A previous book's import confirmation must not follow the user to the next one:
  // it is rendered outside the address-book menu, so a stale one would be visible.
  useEffect(() => { setImportNotice(''); }, [selectedAddressBookId]);
  useEffect(() => { totalRef.current = total; }, [total]);

  const loadAddressBooks = useCallback(async () => {
    if (useStore.getState().authEpoch !== authEpoch) return;
    const generation = ++bookLoadGeneration.current;
    const [books, google, microsoft, dav] = await Promise.all([
      api.addressBooks.list(),
      // A server without a provider adapter must not break the address books.
      api.googleContacts.status().catch(() => null),
      api.microsoftContacts.status().catch(() => null),
      // DAV-05: a CardDAV book needs its own state and action too, not only the provider ones.
      api.carddav.status().catch(() => null),
    ]);
    if (generation !== bookLoadGeneration.current || useStore.getState().authEpoch !== authEpoch) return;
    // Older servers and test fixtures may not expose address books yet. Contacts
    // must remain usable while the client and API roll out independently.
    const nextBooks: AddressBookRow[] = Array.isArray(books.addressBooks) ? books.addressBooks as AddressBookRow[] : [];
    setAddressBooks(nextBooks);
    setSelectedAddressBookIds(current => {
      const valid = new Set(nextBooks.map(book => book.id));
      if (!displaySelectionInitialized.current && nextBooks.length > 0) {
        displaySelectionInitialized.current = true;
        return nextBooks.filter(book => book.visible !== false).map(book => book.id);
      }
      return current.filter(id => valid.has(id));
    });
    setGoogleContacts(google ?? null);
    setMicrosoftContacts(microsoft ?? null);
    setDavStatus(dav ?? null);
    if (settingsOnly) window.dispatchEvent(new Event('inboxora:contact-books-changed'));
  }, [settingsOnly, authEpoch]);

  const load = useCallback(async (q = '') => {
    if (settingsOnly || useStore.getState().authEpoch !== authEpoch) return;
    const requestId = ++listRequestRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(false);
    setLoading(true);
    setListError(null);
    searchRef.current = q;
    try {
      const res = await api.getContacts({ q, limit: PAGE_SIZE, offset: 0, ...contactBookFilter });
      if (requestId !== listRequestRef.current || useStore.getState().authEpoch !== authEpoch) return;
      setContacts(res.contacts);
      setTotal(res.total);
    } catch (err) {
      if (requestId === listRequestRef.current && useStore.getState().authEpoch === authEpoch) setListError(toAppError(err).message);
    } finally {
      if (requestId === listRequestRef.current && useStore.getState().authEpoch === authEpoch) { setLoading(false); loadingMoreRef.current = false; }
    }
  }, [contactBookFilter, settingsOnly, authEpoch]);

  useEffect(() => {
    if (settingsOnly) return;
    const refreshBooks = () => {
      void loadAddressBooks().catch(err => setListError(toAppError(err).message));
      void load(searchRef.current);
    };
    window.addEventListener('inboxora:contact-books-changed', refreshBooks);
    return () => window.removeEventListener('inboxora:contact-books-changed', refreshBooks);
  }, [settingsOnly, loadAddressBooks, load]);

  useEffect(() => {
    clearTimeout(searchTimer.current);
    load(searchRef.current);
    return () => { listRequestRef.current += 1; clearTimeout(searchTimer.current); };
  }, [load]);
  useEffect(() => { loadAddressBooks().catch(err => setListError(toAppError(err).message)); }, [loadAddressBooks]);

  const onSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearch(val);
    searchRef.current = val;
    listRequestRef.current += 1;
    loadingMoreRef.current = true;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(val), 300);
  };

  // Both naming flows go through one dialog. Creating and renaming differ only in which
  // request is sent, so they share the field, the validation message and the keyboard flow.
  const openCreateBook = () => { setBookError(null); setBookDialog({ mode: 'create', id: null, name: '' }); };
  const openRenameBook = (book: { id: string; name?: string | null; source?: string | null; dav_mode?: unknown }) => { setBookError(null); setBookDialog({ mode: 'rename', id: book.id, name: book.name ?? '', davMode: addressBookDavModeOf(book.dav_mode), davEditable: (book.source ?? 'local') === 'local' }); };
  const submitBookDialog = async () => {
    if (!bookDialog || bookSaving) return;
    const name = bookDialog.name.trim();
    if (!name) { setBookError(t('contacts.addressBooks.nameRequired')); return; }
    setBookSaving(true); setBookError(null);
    try {
      if (bookDialog.mode === 'create') {
        const book = await api.addressBooks.create(name);
        await loadAddressBooks();
        setSelectedAddressBookId(book.id);
      } else {
        // The renamed book stays selected, so the list does not jump to another book.
        // The DAV mode only accompanies a local book; an imported one keeps its policy.
        await api.addressBooks.update(bookDialog.id, bookDialog.davEditable ? { name, davMode: bookDialog.davMode } : { name });
        await loadAddressBooks();
      }
      setBookDialog(null);
    } catch (err) { setBookError(toAppError(err).message); }
    finally { setBookSaving(false); }
  };

  const toggleAddressBookVisibility = async () => {
    const book = addressBooks.find(item => item.id === selectedAddressBookId);
    if (!book) return;
    try {
      await api.addressBooks.update(book.id, { visible: !book.visible });
      await loadAddressBooks();
    } catch (err) { setListError(toAppError(err).message); }
  };

  /**
   * Enable or disable write-back for the selected pulled address book.
   *
   * The switch is offered only for a book that has a collection, and the server decides whether the change
   * is allowed: a book whose source reports it as read-only answers `SOURCE_READ_ONLY` and the message is
   * shown rather than the row being flipped locally.
   */
  const toggleAddressBookWriteBack = async () => {
    const book = addressBooks.find(item => item.id === selectedAddressBookId);
    if (!book?.collection_id) return;
    setWritingBack(true);
    try {
      await api.setCollectionWriteBack(String(book.collection_id), book.read_only !== false);
      await loadAddressBooks();
    } catch (err) { setListError(toAppError(err).message); }
    finally { setWritingBack(false); }
  };

  /**
   * Delete a local address book.
   *
   * The last local book cannot be deleted, and a provider collection never can: it is the provider's copy of
   * something that exists elsewhere, so deleting it here would either fail or silently stop syncing it. The
   * server answers the same way; the panel simply does not offer what would be refused.
   */
  const deleteAddressBook = async () => {
    const book = addressBooks.find(item => item.id === selectedAddressBookId);
    const localBooks = addressBooks.filter(item => (item.source ?? 'local') === 'local');
    if (!book || (book.source ?? 'local') !== 'local' || localBooks.length <= 1) return;
    setDeletingBook(true);
    setBookDeleteError(null);
    try {
      await api.addressBooks.remove(book.id);
      setSelectedAddressBookId('');
      setBooksManagerOpen(false);
      await loadAddressBooks();
      await load(searchRef.current);
    } catch (err) { setBookDeleteError(toAppError(err).message); }
    finally { setDeletingBook(false); }
  };

  /** The DAV sharing mode is a property of a local book, and the server enforces that. */
  const changeAddressBookDavMode = async (mode: AddressBookDavMode) => {
    const book = addressBooks.find(item => item.id === selectedAddressBookId);
    if (!book || (book.source ?? 'local') !== 'local') return;
    setDavBusy(true);
    try {
      await api.addressBooks.update(book.id, { davMode: mode });
      await loadAddressBooks();
    } catch (err) { setListError(toAppError(err).message); }
    finally { setDavBusy(false); }
  };

  const operationScope = useRef({ active: true });
  useEffect(() => {
    const scope = { active: true };
    operationScope.current = scope;
    setProviderSyncing(null);
    setProviderNotice(null);
    setSaving(false);
    return () => { scope.active = false; };
  }, [authEpoch, selectedAddressBookId]);
  const currentOperation = () => {
    const scope = operationScope.current;
    return () => scope.active && useStore.getState().authEpoch === authEpoch;
  };

  const runProviderContactsSync = async (provider: 'google' | 'microsoft' | 'dav') => {
    if (providerSyncing) return;
    const selectedProviderBook = addressBooks.find(book => book.id === selectedAddressBookId);
    const accountId = provider !== 'dav' ? providerSyncAccount(selectedProviderBook, provider) : null;
    if (provider !== 'dav' && !accountId) return;
    const current = currentOperation();
    setProviderSyncing(provider);
    setProviderNotice(null);
    setListError(null);
    try {
      if (provider === 'dav') {
        // DAV-05: the CardDAV source has its own sync, and the selected DAV book must be able to start it.
        const result = await api.carddav.sync() as { ok?: boolean; error?: string };
        if (!current()) return;
        setProviderNotice({
          provider: 'dav',
          message: result?.ok === false && result.error
            ? result.error
            : t('admin.integrations.carddav.lastSync', { when: new Date().toLocaleString() }),
        });
        await loadAddressBooks();
        if (!current()) return;
        await load(searchRef.current);
        return;
      }
      // Missing ownership is never permission to synchronise every provider account.
      if (!accountId) return;
      const result = await api.syncAccountProviderFeature(accountId, 'contacts') as AccountContactsSyncResponse;
      if (!current()) return;
      setProviderNotice({ provider, message: accountContactsSyncMessage(result, provider, t) });
      if (result.state === 'success') {
        window.dispatchEvent(new CustomEvent('inboxora:provider-sync-completed', { detail: { accountId } }));
      }
      await loadAddressBooks();
      if (!current()) return;
      await load(searchRef.current);
    } catch (err) {
      if (current()) setListError(toAppError(err).message);
    } finally {
      if (current()) setProviderSyncing(null);
    }
  };

  const importVCardFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedAddressBookId) return;
    try {
      const result = await api.addressBooks.importVCard(selectedAddressBookId, await file.text()) as { imported?: number };
      setImportNotice(t('contacts.addressBooks.importDone', { count: result?.imported ?? 0 }));
      await load(search);
      await loadAddressBooks();
    } catch (err) { setListError(toAppError(err).message); }
    finally { event.target.value = ''; }
  };

  const importGoogleCsv = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedAddressBookId) return;
    try {
      const result = await api.addressBooks.importGoogleCsv(selectedAddressBookId, await file.text()) as { imported?: number };
      setImportNotice(t('contacts.addressBooks.importDone', { count: result?.imported ?? 0 }));
      await load(search);
      await loadAddressBooks();
    } catch (err) { setListError(toAppError(err).message); }
    finally { event.target.value = ''; }
  };

  const handleListScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 200) return;
    if (loadingMoreRef.current || contactsRef.current.length >= totalRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const q = searchRef.current;
    const offset = contactsRef.current.length;
    const requestId = listRequestRef.current;
    api.getContacts({ q, limit: PAGE_SIZE, offset, ...contactBookFilter })
      .then(res => {
        if (requestId !== listRequestRef.current) return;
        setContacts(prev => [...prev, ...res.contacts]);
        setTotal(res.total);
      })
      .catch(err => { if (requestId === listRequestRef.current) setListError(toAppError(err).message); })
      .finally(() => {
        if (requestId !== listRequestRef.current) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [contactBookFilter]);

  const selectContact = async (c: { id: string }) => {
    setError(null);
    if (isMobile) selectedRowIdRef.current = c.id;
    const requestId = ++contactSelectionRequestRef.current;
    try {
      const full = await api.getContact(c.id);
      if (requestId !== contactSelectionRequestRef.current) return;
      setSelected(full);
      setEditing(false);
      setShowNew(false);
      setConfirmDelete(false);
      setError(null);
      if (isMobile) setMobilePanel('detail');
    } catch (err) {
      if (requestId !== contactSelectionRequestRef.current) return;
      setError(toAppError(err).message);
    }
  };

  const startNew = () => {
    const target = initialContactTarget(addressBooks, selectedAddressBookId);
    if (!target) {
      setError(t('contacts.booksManager.readOnly'));
      return;
    }
    contactSelectionRequestRef.current += 1;
    setNewAddressBookId(target.id);
    setSelected(null);
    setForm(emptyContact());
    setEditing(false);
    setShowNew(true);
    setConfirmDelete(false);
    setError(null);
    if (isMobile) setMobilePanel('detail');
  };

  const goBackToList = () => {
    contactSelectionRequestRef.current += 1;
    setMobilePanel('list');
    setSelected(null);
    setShowNew(false);
    setEditing(false);
    setError(null);
  };

  const startEdit = () => {
    if (!selected) return;
    setForm({
      displayName:  selected.display_name  || '',
      firstName:    selected.first_name    || '',
      lastName:     selected.last_name     || '',
      emails:       (selected.emails?.length
        ? selected.emails.map((entry: Record<string, unknown>) => ({ value: String(entry.value ?? ''), type: String(entry.type ?? ''), primary: Boolean(entry.primary) }))
        : EmptyEmailForm()),
      phones:       (selected.phones || []).map(entry => ({ value: String(entry.value ?? ''), type: String(entry.type ?? '') })),
      organization: selected.organization  || '',
      notes:        selected.notes         || '',
      contactDates: selected.contactDates?.length
        ? selected.contactDates.map(entry => ({ value: String(entry.value ?? ''), label: String(entry.label ?? '') }))
        : [
            selected.birthday && { label: 'Birthday', value: String(selected.birthday).slice(0, 10) },
            selected.anniversary && { label: 'Anniversary', value: String(selected.anniversary).slice(0, 10) },
          ].filter((date): date is FormDate => Boolean(date)),
      title:        selected.title || '',
      role:         selected.role || '',
      nickname:     selected.nickname || '',
      urls:         (selected.urls || []).map(entry => ({ value: String(entry.value ?? ''), type: String(entry.type ?? '') })),
      instantMessages: (selected.instantMessages || []).map(entry => ({ value: String(entry.value ?? ''), type: String(entry.type ?? '') })),
      categories:   selected.categories || [],
      addresses:    (selected.addresses || []).map(entry => ({ type: String(entry.type ?? ''), pobox: String(entry.pobox ?? ''), extended: String(entry.extended ?? ''), street: String(entry.street ?? ''), locality: String(entry.locality ?? ''), region: String(entry.region ?? ''), postalCode: String(entry.postalCode ?? ''), country: String(entry.country ?? '') })),
    });
    setEditing(true);
    setError(null);
  };

  const cancelEdit = useCallback(() => {
    if (showNew) {
      setShowNew(false);
      if (isMobile) setMobilePanel('list');
    } else {
      setEditing(false);
    }
    setError(null);
  }, [isMobile, showNew]);

  const inForm = editing || showNew;

  useBackLayer(showContacts && isMobile && mobilePanel === 'detail', goBackToList, 30);
  useBackLayer(showContacts && inForm, () => { if (!saving) cancelEdit(); }, 40);
  useBackLayer(showContacts && confirmDelete, () => setConfirmDelete(false), 9100);

  const saveContact = async () => {
    if (saving) return;
    const current = currentOperation();
    setSaving(true);
    setError(null);
    try {
      const derivedDisplayName =
        form.displayName.trim() ||
        [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(' ') ||
        null;
      const payload = {
        displayName:  derivedDisplayName,
        firstName:    form.firstName    || null,
        lastName:     form.lastName     || null,
        emails:       form.emails.filter(e => e.value.trim()),
        phones:       form.phones.filter(p => p.value.trim()),
        organization: form.organization || null,
        notes:        form.notes        || null,
        contactDates: form.contactDates.filter(date => date.value).map(({ label, value }) => ({ label, value })),
        title:        form.title || null,
        role:         form.role || null,
        nickname:     form.nickname || null,
        urls:         form.urls.filter(item => item.value.trim()),
        instantMessages: form.instantMessages.filter(item => item.value.trim()),
        categories:   form.categories.filter(Boolean),
        addresses:    form.addresses.filter(address => Object.entries(address).some(([key, value]) => key !== 'type' && typeof value === 'string' && value.trim())),
      };
      let saved;
      if (showNew) {
        // Re-read capabilities at save time. Never silently reroute a vanished/read-only target.
        const latest = await api.addressBooks.list();
        if (!current()) return;
        const books = Array.isArray(latest.addressBooks) ? latest.addressBooks : [];
        setAddressBooks(books);
        if (!writableContactTarget(books, newAddressBookId)) {
          setError(t('contacts.booksManager.readOnly'));
          return;
        }
        saved = await api.createContact({ ...payload, addressBookId: newAddressBookId });
      } else {
        if (!selected) return;
        saved = await api.updateContact(selected.id, payload);
      }
      // Reload list and re-fetch the saved contact before touching UI state,
      // so that any error here is still shown inside the open form.
      if (!current()) return;
      await load(search);
      if (!current()) return;
      const updated = await api.getContact(saved.id);
      if (!current()) return;
      setShowNew(false);
      setEditing(false);
      setSelected(updated);
    } catch (err) {
      if (current()) setError(toAppError(err).message);
    } finally {
      if (current()) setSaving(false);
    }
  };

  const deleteContact = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.deleteContact(selected.id);
      setSelected(null);
      setConfirmDelete(false);
      if (isMobile) setMobilePanel('list');
      await load(search);
    } catch (err) {
      setError(toAppError(err).message);
    } finally {
      setSaving(false);
    }
  };

  // Form field helpers
  const setFormField = (key: string, val: unknown) => setForm(f => ({ ...f, [key]: val }));

  const setEmail = (idx: number, field: string, val: string) => setForm(f => {
    const emails = f.emails.map((e, i) => i === idx ? { ...e, [field]: val } : e);
    return { ...f, emails };
  });

  const addEmail = () => setForm(f => ({
    ...f, emails: [...f.emails, { value: '', type: 'other', primary: false }],
  }));

  const removeEmail = (idx: number) => setForm(f => ({
    ...f, emails: f.emails.filter((_, i) => i !== idx),
  }));

  const setPhone = (idx: number, field: string, val: string) => setForm(f => {
    const phones = f.phones.map((p, i) => i === idx ? { ...p, [field]: val } : p);
    return { ...f, phones };
  });

  const addPhone = () => setForm(f => ({
    ...f, phones: [...f.phones, { value: '', type: 'mobile' }],
  }));

  const removePhone = (idx: number) => setForm(f => ({
    ...f, phones: f.phones.filter((_, i) => i !== idx),
  }));

  const setCollection = (key: string, idx: number, field: string, value: string) => setForm(f => {
    const list = f[key];
    if (!Array.isArray(list)) return f;
    return { ...f, [key]: list.map((item: Record<string, unknown>, i: number) => i === idx ? { ...item, [field]: value } : item) };
  });

  const addCollection = (key: string, item: unknown) => setForm(f => {
    const list = f[key];
    return { ...f, [key]: [...(Array.isArray(list) ? list : []), item] };
  });
  const removeCollection = (key: string, idx: number) => setForm(f => {
    const list = f[key];
    if (!Array.isArray(list)) return f;
    return { ...f, [key]: list.filter((_: Record<string, unknown>, i: number) => i !== idx) };
  });
  const setCategories = (value: string) => setForm(f => ({ ...f, categories: value.split(',').map(category => category.trim()).filter(Boolean) }));

  const googleSummary = providerConnectorSummary(googleContacts?.books, {
    id: book => book.addressBookId,
    count: book => book.contactCount ?? 0,
    failureKey: code => providerFailureKey(code) ?? 'contacts.addressBooks.lastSyncFailed',
  });
  const microsoftSummary = providerConnectorSummary(microsoftContacts?.books, {
    id: book => book.addressBookId,
    count: book => book.contactCount ?? 0,
    failureKey: code => providerFailureKey(code) ?? 'contacts.addressBooks.lastSyncFailed',
  });
  const selectedBook = addressBooks.find(book => book.id === selectedAddressBookId);
  const toggleDisplayedBook = (id: string) => setSelectedAddressBookIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const setDisplayedBooks = (ids: string[]) => setSelectedAddressBookIds([...new Set(ids)]);
  const selectedCount = selectedAddressBookIds.length;
  const bookGroups = groupBooksByConnection(addressBooks.map(book => ({
    id: book.id, source: book.source ?? 'local', accountId: book.account_id ?? null,
    connectionId: book.connection_id ?? null, accountLabel: book.account_email ?? null, book,
  })));
  const bookControls = <div className="contacts-book-controls">
    <button type="button" className="contacts-books-trigger" data-testid="contacts-books-trigger" aria-expanded={booksOpen} onClick={() => setBooksOpen(true)}>
      {t('contacts.addressBooks.displayedBooks', { selected: selectedCount, total: addressBooks.length })}
    </button>
    {booksOpen && <div className="contacts-books-panel" role="dialog" aria-label={t('contacts.addressBooks.label')}>
      <div className="contacts-books-actions">
        <button type="button" onClick={() => setDisplayedBooks(addressBooks.map(book => book.id))}>{t('contacts.addressBooks.showAll')}</button>
        <button type="button" onClick={() => setDisplayedBooks([])}>{t('contacts.addressBooks.clearAll')}</button>
        <button type="button" onClick={() => setBooksOpen(false)} aria-label={t('common.close')}>×</button>
      </div>
      {bookGroups.map(group => {
        const ids = group.books.map(item => item.id);
        const selectedInGroup = ids.filter(id => selectedAddressBookIds.includes(id)).length;
        return <section key={group.id} className="contacts-book-group">
          <header>
            <input type="checkbox" aria-label={group.accountLabel ?? group.source} checked={selectedInGroup === ids.length} ref={element => { if (element) element.indeterminate = selectedInGroup > 0 && selectedInGroup < ids.length; }} onChange={() => setDisplayedBooks(selectedInGroup === ids.length ? selectedAddressBookIds.filter(id => !ids.includes(id)) : [...selectedAddressBookIds, ...ids])} />
            <strong>{group.source}</strong>{group.accountLabel && <span>{group.accountLabel}</span>}
          </header>
          {group.books.map(item => <div key={item.id} className="contacts-book-row" role="button" tabIndex={0} aria-label={item.book.name ?? item.id}
            onClick={() => toggleDisplayedBook(item.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDisplayedBook(item.id); } }}>
            <input type="checkbox" aria-label={item.book.name ?? item.id} checked={selectedAddressBookIds.includes(item.id)} onClick={event => event.stopPropagation()} onChange={() => toggleDisplayedBook(item.id)} />
            <span>{item.book.name ?? item.id}</span>
            <small>{item.book.read_only ? t('contacts.booksManager.readOnly') : t('contacts.booksManager.readWrite')}</small>
          </div>)}
        </section>;
      })}
    </div>}
    {/* One entry point into the manager: a compact icon, because a labelled button competed with the book
        strip for the little room the header has. The panel it opens is the full manager. */}
    <button
      type="button"
      data-testid="contacts-manage-books"
      aria-label={t('contacts.booksManager.manage')}
      title={t('contacts.booksManager.manage')}
      onClick={openBookSettings}
      style={{
        flexShrink: 0,
        width: isMobile ? 44 : 34,
        height: isMobile ? 44 : 34,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 8, color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
      }}
    >
      <svg width={isMobile ? 20 : 17} height={isMobile ? 20 : 17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
        {/* An address book with a bookmark, which is what the panel manages. */}
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
        <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5" />
        <path d="M12 3v7l2.5-1.5L17 10V3" />
      </svg>
    </button>
    <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={importGoogleCsv} style={{ display: 'none' }} />
    <input ref={importVCardRef} type="file" accept=".vcf,text/vcard" onChange={importVCardFile} style={{ display: 'none' }} />
    {importNotice && <p role="status" data-testid="contacts-import-result" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{importNotice}</p>}
    {providerNotice && <p role="status" data-testid={`contacts-${providerNotice.provider}-sync-result`} style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{providerNotice.message}</p>}
  </div>;
  const managerBooks = addressBooks.map(book => {
    const source = book.source ?? 'unknown';
    const providerForBook = source === 'google' ? 'google' : source === 'microsoft' ? 'microsoft' : null;
    const providerRows = providerForBook === 'google' ? googleContacts?.books : providerForBook === 'microsoft' ? microsoftContacts?.books : null;
    const row = providerRows?.find(candidate => candidate.addressBookId === book.id);
    // DAV-05: a CardDAV book reports the source's own last sync rather than "never", and its failure code when
    // the last run failed. The status is per source until DAV sources are separate connections (DAV-01).
    const isDavBook = source === 'carddav' || source === 'dav';
    const davSummary: { key: string | null; values: Record<string, string> } | null = isDavBook
      ? davStatus?.errorCode
        ? { key: providerFailureKey(davStatus.errorCode) ?? 'contacts.addressBooks.lastSyncFailed', values: {} }
        : davStatus?.lastSyncAt
          ? { key: 'admin.integrations.carddav.lastSync', values: { when: new Date(davStatus.lastSyncAt).toLocaleString() } }
          : null
      : null;
    const summary = row
      ? providerConnectorSummary([row], {
          id: candidate => candidate.addressBookId,
          count: candidate => candidate.contactCount ?? 0,
          failureKey: code => providerFailureKey(code) ?? 'contacts.addressBooks.lastSyncFailed',
        })
      : davSummary;
    return {
      id: book.id,
      name: book.name ?? '',
      source,
      visible: book.visible !== false,
      readOnly: book.read_only !== false,
      collectionId: book.collection_id ?? null,
      accountLabel: typeof book.account_email === 'string' ? book.account_email : null,
      accountId: book.account_id ?? null,
      connectionId: book.connection_id ?? (typeof book.source_connection_id === 'string' ? book.source_connection_id : null),
      canSyncProvider: providerForBook !== null && providerSyncAccount(book, providerForBook) !== null,
      contactCount: typeof book.contact_count === 'number' ? book.contact_count : (row?.contactCount ?? null),
      syncStatus: summary,
    };
  });
  const booksManager = <ContactsBooksManager
    open={settingsOnly || booksManagerOpen}
    onClose={() => setBooksManagerOpen(false)}
    books={managerBooks}
    selectedBookId={selectedAddressBookId}
    onSelectBook={setSelectedAddressBookId}
    isMobile={isMobile}
    t={t}
    onCreate={openCreateBook}
    onRename={book => openRenameBook(book)}
    onToggleVisibility={toggleAddressBookVisibility}
    onToggleWriteBack={toggleAddressBookWriteBack}
    writingBack={writingBack}
    canDelete
    onDelete={deleteAddressBook}
    deleting={deletingBook}
    deleteError={bookDeleteError}
    google={{ configured: !!googleContacts?.configured, connected: !!googleContacts?.connected }}
    microsoft={{ configured: !!microsoftContacts?.configured, connected: !!microsoftContacts?.connected }}
    syncing={providerSyncing}
    onSync={runProviderContactsSync}
    googleSummary={googleSummary}
    microsoftSummary={microsoftSummary}
    dav={{ configured: true, connected: davStatus?.connected === true }}
    onDavChanged={async () => {
      // DAV-01: connecting or synchronising a DAV source changes the books, so the list on screen is reloaded
      // rather than left showing the state from before the action.
      await loadAddressBooks();
      await load(searchRef.current);
    }}
    onImportGoogleCsv={() => importInputRef.current?.click()}
    onImportVCard={() => importVCardRef.current?.click()}
    exportUrl={format => api.addressBooks.exportUrl(selectedAddressBookId, format)}
    davMode={addressBookDavModeOf(selectedBook?.dav_mode)}
    onDavModeChange={changeAddressBookDavMode}
    davBusy={davBusy}
    view={settingsSection}
  />;

  // Rendered by both layouts: the address-book menu is shared, so its dialog must be too.
  const bookNameDialog = bookDialog && <Dialog
    title={t(bookDialog.mode === 'create' ? 'contacts.addressBooks.create' : 'contacts.addressBooks.renameTitle')}
    closeLabel={t('common.close')}
    busy={bookSaving}
    onClose={() => { if (!bookSaving) setBookDialog(null); }}
    testId="contacts-book-name-dialog"
    footer={<>
      <Button onClick={() => setBookDialog(null)} disabled={bookSaving}>{t('common.cancel')}</Button>
      <Button variant="primary" onClick={submitBookDialog} disabled={bookSaving || !bookDialog.name.trim()}>
        {t(bookSaving ? 'common.saving' : 'common.save')}
      </Button>
    </>}
  >
    <div className="ui-form">
      {bookError && <div role="alert" className="ui-alert">{bookError}</div>}
      <label>{t('contacts.addressBooks.nameLabel')}
        <input
          data-testid="contacts-book-name-input"
          autoFocus
          maxLength={120}
          value={bookDialog.name}
          onChange={event => setBookDialog(current => current ? { ...current, name: event.target.value } : current)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submitBookDialog(); } }}
        />
      </label>
      {/* DAV sharing is per address book, so a device password can never widen it. */}
      {bookDialog.mode === 'rename' && bookDialog.davEditable && (
        <>
          <label>{t('calendar.davAccess')}
            <select
              data-testid="contacts-book-dav-mode"
              value={bookDialog.davMode}
              onChange={event => setBookDialog(current => current && current.mode === 'rename' ? { ...current, davMode: addressBookDavModeOf(event.target.value) } : current)}
            >
              <option value="off">{t('calendar.davAccessOff')}</option>
              <option value="read_only">{t('calendar.davAccessReadOnly')}</option>
              <option value="read_write">{t('calendar.davAccessReadWrite')}</option>
            </select>
          </label>
          <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>{t('contacts.addressBooks.davAccessHint')}</p>
        </>
      )}
    </div>
  </Dialog>;
  const searchControl = <div className="contacts-search">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.4-4.4" /></svg>
    <input type="search" value={search} onChange={onSearchChange} aria-label={t('contacts.search')} placeholder={t('contacts.search')} style={{ ...sharedInputStyle, paddingLeft: 30 }} />
  </div>;

  // Shared list panel content (used by both mobile and desktop)
  const listPanel = (
    <>
      {listError && contacts.length > 0 && <ErrorBanner msg={listError} />}
      {/* List */}
      <div
        data-testid="contacts-list-scroll"
        style={{
          flex: 1, overflowY: 'auto', boxSizing: 'border-box',
          paddingBottom: isMobile ? 'calc(var(--sab) + 12px)' : 0,
        }}
        onScroll={handleListScroll}
      >
        {loading && !contacts.length && (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
            {t('common.loading')}
          </div>
        )}
        {!loading && !contacts.length && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: listError ? 'var(--red, #f87171)' : 'var(--text-tertiary)' }}>
            {listError || (search ? t('contacts.noResults') : t('contacts.empty'))}
          </div>
        )}
        {contacts.map(c => {
          const contactName = c.display_name || c.primary_email || '—';
          return (
          <div
            key={c.id}
            ref={element => {
              if (element) rowRefs.current.set(c.id, element);
              else rowRefs.current.delete(c.id);
            }}
            data-contact-id={c.id}
            aria-pressed={selected?.id === c.id}
            role="button"
            tabIndex={0}
            aria-label={contactName}
            onClick={() => selectContact(c)}
            onKeyDown={ (e: React.KeyboardEvent<HTMLElement>) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              selectContact(c);
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: 'var(--layout-row-py) var(--layout-row-px)', cursor: 'pointer',
              borderBottom: '1px solid var(--border-subtle)',
              background: selected?.id === c.id ? 'var(--accent-dim)' : 'transparent',
              transition: 'background 0.1s',
            }}
            onMouseEnter={ (e: React.MouseEvent<HTMLElement>) => { if (selected?.id !== c.id) e.currentTarget.style.background = 'color-mix(in srgb, var(--bg-hover) 42%, transparent)'; }}
            onMouseLeave={ (e: React.MouseEvent<HTMLElement>) => { if (selected?.id !== c.id) e.currentTarget.style.background = 'transparent'; }}
          >
            <Avatar
              name={c.display_name}
              email={c.primary_email}
              size={36}
              hasContactPhoto={c.has_contact_photo}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {contactName}
              </div>
              {c.display_name && c.primary_email && (
                <div style={{
                  fontSize: 12, color: 'var(--text-secondary)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {c.primary_email}
                </div>
              )}
            {Boolean(c.organization || c.is_auto || c.address_book_id) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                {Boolean(c.address_book_id) && <span style={rowTypeChip}>{addressBooks.find(book => book.id === c.address_book_id)?.name}</span>}
                {c.organization && <span style={rowTypeChip}>{c.organization}</span>}
                {Boolean(c.is_auto) && <span style={rowTypeChip}>{t('contacts.auto')}</span>}
              </div>
            )}
            </div>
          </div>
          );
        })}
        {loadingMore && (
          <div style={{ padding: '10px 14px', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
            {t('common.loading')}
          </div>
        )}
      </div>

      {total > 0 && (
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {contacts.length < total
            ? `${contacts.length} / ${t('contacts.count', { count: total })}`
            : t('contacts.count', { count: total })
          }
        </div>
      )}
    </>
  );

  // Shared detail / form content
  const detailPanel = (
    <>
      {!selected && !showNew && !isMobile && (
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)', textAlign: 'center', gap: 14, padding: 24,
        }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ opacity: 0.25 }}>
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87"/>
            <path d="M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <div style={{ fontSize: 15, color: 'var(--text-secondary)' }}>{t('contacts.selectHint')}</div>
          <button
            onClick={startNew}
            style={{
              marginTop: 4, background: 'var(--accent)', border: 'none', borderRadius: 7,
              color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
              padding: '7px 14px', cursor: 'pointer',
            }}
          >
            + {t('contacts.new')}
          </button>
        </div>
      )}
      {inForm && (
        <>
          {showNew && <label data-testid="contacts-new-target" style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 10px', color: 'var(--text-secondary)', fontSize: 13 }}>
            {t('contacts.newTarget')}
            <select value={newAddressBookId} disabled={saving} onChange={event => setNewAddressBookId(event.target.value)} style={{ maxWidth: 280 }}>
              {!writableContactTarget(addressBooks, newAddressBookId) && <option value={newAddressBookId} disabled>{t('contacts.booksManager.readOnly')}</option>}
              {addressBooks.filter(book => book.read_only !== true).map(book => <option key={book.id} value={book.id}>{book.name}{book.account_email ? ` · ${book.account_email}` : ''}</option>)}
            </select>
          </label>}
        <ContactForm
          key={showNew ? 'new' : selected?.id}
          form={form}
          isNew={showNew}
          saving={saving}
          error={error}
          onField={setFormField}
          onSetEmail={setEmail}
          onAddEmail={addEmail}
          onRemoveEmail={removeEmail}
          onSetPhone={setPhone}
          onAddPhone={addPhone}
          onRemovePhone={removePhone}
          onSetCollection={setCollection}
          onAddCollection={addCollection}
          onRemoveCollection={removeCollection}
          onSetCategories={setCategories}
          onSave={saveContact}
          onCancel={cancelEdit}
          t={t}
        />
        </>
      )}
      {selected && !inForm && (
        <ContactDetail
          key={selected.id}
          contact={selected}
          confirmDelete={confirmDelete}
          saving={saving}
          error={error}
          onEdit={startEdit}
          onDeleteRequest={() => setConfirmDelete(true)}
          onDeleteConfirm={deleteContact}
          onDeleteCancel={() => setConfirmDelete(false)}
          t={t}
        />
      )}
    </>
  );

  // The settings route is the sole book-management surface. It reuses this
  // controller's operations without mounting the contact reader/list UI.
  if (settingsOnly) return <section data-testid="contacts-settings">
    {listError && <p role="alert" className="ui-alert">{listError}</p>}
    {providerNotice && <p role="status">{providerNotice.message}</p>}
    {importNotice && <p role="status">{importNotice}</p>}
    <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={importGoogleCsv} hidden />
    <input ref={importVCardRef} type="file" accept=".vcf,text/vcard" onChange={importVCardFile} hidden />
    {booksManager}{bookNameDialog}
  </section>;

  // ── Mobile layout ─────────────────────────────────────────────────────────
  if (isMobile) {
    const mobileHeaderTitle = mobilePanel === 'detail' && selected
      ? (selected.display_name || selected.primary_email || t('contacts.title'))
      : t('contacts.title');

    return (
      <div className="contacts-page contacts-compact" style={{ display: 'flex', flex: 1, width: '100%', minWidth: 0, flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-secondary)' }}>
        {showContacts && <MobileFloatingAction label={t('contacts.new')} onClick={startNew} disabled={inForm} />}
        {phone && <MobileModuleHeader
          leading={mobilePanel === 'detail' ? <button type="button" ref={mobileBackButtonRef} className="mobile-header-action" onClick={inForm ? cancelEdit : goBackToList} aria-label={t('contacts.backToList')}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
          </button> : undefined}
          title={mobileHeaderTitle}
          subtitle={mobilePanel === 'detail' ? undefined : (selectedBook?.name || t('contacts.addressBooks.allVisible'))}
        >
          <HeaderAction icon="books" label={t('contacts.addressBooks.label')} data-testid="contacts-address-books" onClick={() => setBooksOpen(true)} />
          <HeaderAction icon="add" label={t('contacts.new')} data-testid="contacts-header-new" onClick={startNew} disabled={inForm} />
        </MobileModuleHeader>}
        {!phone && <div className="contacts-compact-heading">
          {mobilePanel === 'detail' && <button type="button" ref={mobileBackButtonRef} className="mobile-header-action" onClick={inForm ? cancelEdit : goBackToList} aria-label={t('contacts.backToList')}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
          </button>}
          <h2>{mobileHeaderTitle}</h2>
          <HeaderAction icon="add" label={t('contacts.new')} onClick={startNew} disabled={inForm} />
        </div>}
        {mobilePanel === 'list' && <div className="contacts-list-header">{!phone && bookControls}{searchControl}</div>}
        {phone && booksOpen && <Dialog title={t('contacts.addressBooks.label')} closeLabel={t('common.close')} onClose={() => setBooksOpen(false)} testId="contacts-books-dialog" className="contacts-books-dialog">
          {bookControls}
        </Dialog>}
        {bookNameDialog}

        {/* Content */}
        {mobilePanel === 'list' ? (
          <>
            <div data-testid="contacts-mobile-list" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'slide-in-left var(--motion-normal) var(--ease-emphasized) both' }}>
              {listPanel}
            </div>

          </>
        ) : (
          <div data-testid="contacts-mobile-detail" style={{ flex: 1, overflow: 'hidden auto', padding: '20px 16px', animation: 'slide-in-right var(--motion-normal) var(--ease-emphasized) both' }}>
            {detailPanel}
          </div>
        )}
      </div>
    );
  }

  // ── Desktop layout ────────────────────────────────────────────────────────
  return (
    <div className="contacts-page" style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', background: 'var(--bg-primary)' }}>

      {/* Contact list panel */}
      <div data-testid="contacts-desktop-list" style={{
        flex: '0 0 var(--list-width)', width: 'var(--list-width)', display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border-subtle)',
        background: 'var(--bg-primary)',
        overflow: 'hidden',
      }}>
        <div className="contacts-list-header">
          <div className="contacts-heading"><h1>{t('contacts.title')}</h1><Button variant="primary" onClick={startNew}>+ {t('contacts.new')}</Button></div>
          <p className="contacts-subtitle">{t('contacts.listSubtitle')}</p>
          {bookControls}{searchControl}
        </div>

        {listPanel}
      </div>

      <PanelResizeHandle testId="contacts-list-resize" onMouseDown={handleListResizeMouseDown} />

      {/* Detail / form panel — keyed by contact id so scroll resets when switching contacts.
          When nothing is selected, center the empty-state placeholder in the full pane. */}
      <div data-testid="contacts-desktop-detail" key={selected?.id ?? (showNew ? 'new' : 'empty')} style={{
        flex: 1, overflow: 'hidden auto', minWidth: 0,
        background: 'var(--bg-secondary)',
        padding: (!selected && !showNew) ? 0 : '26px 30px',
        ...((!selected && !showNew) && { display: 'flex', alignItems: 'center', justifyContent: 'center' }),
      }}>
        {detailPanel}
      </div>
      {bookNameDialog}
    </div>
  );
}

function ContactDetail({ contact: c, confirmDelete, saving, error, onEdit, onDeleteRequest, onDeleteConfirm, onDeleteCancel, t }: ContactDetailProps) {
  const { i18n } = useTranslation();
  const detailType = (type?: string) => type ? t(`contacts.emailTypes.${type}`, { defaultValue: String(type) }) : undefined;
  const openCompose = useStore((state: StoreState) => state.openCompose);
  const contactDates = c.contactDates?.length
    ? c.contactDates
    : [
        c.birthday && { label: 'Birthday', value: String(c.birthday).slice(0, 10) },
        c.anniversary && { label: 'Anniversary', value: String(c.anniversary).slice(0, 10) },
      ].filter((date): date is { label: string; value: string } => Boolean(date));
  const primaryEmail = c.primary_email || c.emails?.[0]?.value || '';
  const isReadOnly = c.read_only === true;
  const isAuto = c.is_auto === true;

  return (
    <div style={{ width: '100%', maxWidth: 600, position: 'relative', animation: 'pane-fade-in var(--motion-normal) var(--ease-emphasized) both' }}>
      {/* Actions wrap above the contact heading so long names remain readable. */}
      {!isReadOnly && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <ActionBtn onClick={onEdit}>{t('common.edit')}</ActionBtn>
          <ActionBtn onClick={onDeleteRequest} danger>{t('common.delete')}</ActionBtn>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18, paddingRight: 0 }}>
        <Avatar
          name={c.display_name}
          email={c.primary_email}
          size={56}
          hasContactPhoto={Boolean(c.photo_data)}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
            {c.display_name || c.primary_email}
            {c.nickname && <span style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 400 }}> ({c.nickname})</span>}
          </h2>
          {(c.title || c.organization) && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[c.title, c.organization].filter(Boolean).join(', ')}
            </div>
          )}
          {/* Context chips (CardDAV provenance, last contact) sit in flow below the name
              so they can never overlap it, whatever their translated width. */}
          {(isReadOnly || c.last_sent) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              {isReadOnly && (
                <span style={contactStatChip}>{t('contacts.carddavBadge')}</span>
              )}
              {c.last_sent && (
                <span style={contactStatChip}>{t('contacts.fields.lastContacted')}: {new Date(c.last_sent).toLocaleDateString(intlLocale(i18n.resolvedLanguage || i18n.language))}</span>
              )}
            </div>
          )}
          {isAuto && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('contacts.autoHint')}</div>
          )}
        </div>
      </div>

      {error && <ErrorBanner msg={error} />}

      {confirmDelete && (
        <div data-testid="contacts-delete-confirmation" style={{
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--red-dim, rgba(248,113,113,0.1))',
          border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
          marginBottom: 20,
        }}>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10 }}>
            {t('contacts.deleteConfirm')}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <ActionBtn onClick={onDeleteConfirm} danger disabled={saving}>
              {saving ? t('common.deleting') : t('common.delete')}
            </ActionBtn>
            <ActionBtn onClick={onDeleteCancel}>{t('common.cancel')}</ActionBtn>
          </div>
        </div>
      )}

      {((c.emails && c.emails.length > 0) || (c.phones && c.phones.length > 0) || c.notes || contactDates.length || c.title || c.role || c.nickname || c.urls?.length || c.instantMessages?.length || c.categories?.length || c.addresses?.length) && (
        <div>
          {(c.emails && c.emails.length > 0) && (
            <DetailSection label={t('contacts.fields.email')}>
              {(c.emails || []).map((e, i) => {
                const email = e.value;
                if (typeof email !== 'string') return null;
                return (
                  <DetailRow key={i} icon={fieldIcon.mail} type={t(`contacts.emailTypes.${e.type || 'other'}`, { defaultValue: t('contacts.emailTypes.other') })}>
                    <a href={`mailto:${email}`} onClick={event => { event.preventDefault(); openCompose({ to: [{ email }] }); }} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{email}</a>
                  </DetailRow>
                );
              })}
            </DetailSection>
          )}
          {(c.phones && c.phones.length > 0) && (
            <DetailSection label={t('contacts.fields.phone')}>
              {(c.phones || []).map((p, i) => (
                <DetailRow key={i} icon={fieldIcon.phone} type={t(`contacts.phoneTypes.${p.type === 'cell' || p.type === 'iphone' ? 'mobile' : (p.type || 'other')}`, { defaultValue: t('contacts.phoneTypes.other') })}>
                  <a href={`tel:${p.value}`} style={{ color: 'var(--text-primary)', textDecoration: 'none' }}>{p.value}</a>
                </DetailRow>
              ))}
            </DetailSection>
          )}
          {(c.urls && c.urls.length > 0) && (
            <DetailSection label={t('contacts.fields.url')}>
              {(c.urls || []).map((url, i) => {
                const href = safeHttpUrl(url.value);
                return <DetailRow key={`url-${i}`} icon={fieldIcon.globe} type={detailType(url.type)}>{href ? <a href={href} rel="noreferrer" target="_blank" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{url.value}</a> : url.value}</DetailRow>;
              })}
            </DetailSection>
          )}
          {(c.instantMessages && c.instantMessages.length > 0) && (
            <DetailSection label={t('contacts.fields.instantMessage')}>
              {(c.instantMessages || []).map((message, i) => <DetailRow key={`im-${i}`} icon={fieldIcon.message} type={message.type ? String(message.type) : undefined}>{message.value}</DetailRow>)}
            </DetailSection>
          )}
          {(c.addresses && c.addresses.length > 0) && (
            <DetailSection label={t('contacts.fields.address')}>
              {(c.addresses || []).map((address, i) => <DetailRow key={`address-${i}`} icon={fieldIcon.mapPin} type={detailType(address.type)}>{[address.pobox, address.extended, address.street, address.locality, address.region, address.postalCode, address.country].filter(Boolean).join(', ')}</DetailRow>)}
            </DetailSection>
          )}
          {(contactDates.length > 0) && (
            <DetailSection label={t('contacts.fields.dates')}>
              {contactDates.map((date, i) => <DetailRow key={`date-${i}`} icon={fieldIcon.calendar} type={contactDateLabel(date.label, t)}>{formatContactDate(date.value, intlLocale(i18n.resolvedLanguage || i18n.language))}</DetailRow>)}
            </DetailSection>
          )}
          {(c.categories && c.categories.length > 0) && (
            <DetailSection label={t('contacts.fields.categories')}>
              <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                {c.categories.map((category, i) => <span key={`cat-${i}`} style={{ ...contactStatChip, margin: '2px 6px 2px 0' }}>{category}</span>)}
              </div>
            </DetailSection>
          )}
          {c.notes && (
            <DetailSection label={t('contacts.fields.notes')}>
              <p style={detailNote}>{c.notes}</p>
            </DetailSection>
          )}
          {(c.role || (typeof c.send_count === 'number' && c.send_count > 0)) && (
            <DetailSection>
              {c.role && <DetailRow icon={fieldIcon.briefcase} type={t('contacts.fields.role')}>{c.role}</DetailRow>}
              {typeof c.send_count === 'number' && c.send_count > 0 && <DetailRow icon={fieldIcon.mail} type={t('contacts.fields.emailsSent')}>{c.send_count}</DetailRow>}
            </DetailSection>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
        <button
          type="button"
          onClick={() => { if (primaryEmail) openCompose({ to: [{ email: primaryEmail }] }); }}
          disabled={!primaryEmail}
          className="btn-press"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            background: 'var(--accent)', color: 'var(--accent-text)', border: 'none',
            borderRadius: 6, padding: '8px 14px', fontSize: 12.5, fontWeight: 600,
            cursor: primaryEmail ? 'pointer' : 'not-allowed', opacity: primaryEmail ? 1 : 0.6,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          {t('contacts.composeTo')}
        </button>
      </div>
    </div>
  );
}

/** The add/edit contact form and every mutation its fields need. */
interface ContactFormProps {
  form: ContactFormState;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  onField: (key: string, val: unknown) => void;
  onSetEmail: (idx: number, field: string, val: string) => void;
  onAddEmail: () => void;
  onRemoveEmail: (idx: number) => void;
  onSetPhone: (idx: number, field: string, val: string) => void;
  onAddPhone: () => void;
  onRemovePhone: (idx: number) => void;
  onSetCollection: (key: string, idx: number, field: string, value: string) => void;
  onAddCollection: (key: string, item: unknown) => void;
  onRemoveCollection: (key: string, idx: number) => void;
  onSetCategories: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  t: TFunction;
}
function ContactForm({
  form, isNew, saving, error,
  onField, onSetEmail, onAddEmail, onRemoveEmail,
  onSetPhone, onAddPhone, onRemovePhone,
  onSetCollection, onAddCollection, onRemoveCollection, onSetCategories,
  onSave, onCancel, t,
}: ContactFormProps) {
  const inputStyle = sharedInputStyle;
  const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4, display: 'block' };

  return (
    <div className="contacts-form" style={{ width: '100%', animation: 'pane-fade-in var(--motion-normal) var(--ease-emphasized) both' }}>
      <h2 style={{ margin: '0 0 24px', fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
        {isNew ? t('contacts.newContact') : t('contacts.editContact')}
      </h2>

      {error && <ErrorBanner msg={error} />}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label htmlFor="contact-firstName" style={labelStyle}>{t('contacts.fields.firstName')}</label>
          <input id="contact-firstName" style={inputStyle} value={form.firstName} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('firstName', e.target.value)} />
        </div>
        <div>
          <label htmlFor="contact-lastName" style={labelStyle}>{t('contacts.fields.lastName')}</label>
          <input id="contact-lastName" style={inputStyle} value={form.lastName} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('lastName', e.target.value)} />
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="contact-displayName" style={labelStyle}>{t('contacts.fields.displayName')}</label>
        <input id="contact-displayName" style={inputStyle} value={form.displayName} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('displayName', e.target.value)} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label htmlFor="contact-organization" style={labelStyle}>{t('contacts.fields.organization')}</label>
        <input id="contact-organization" style={inputStyle} value={form.organization} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('organization', e.target.value)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div><label htmlFor="contact-title" style={labelStyle}>{t('contacts.fields.title')}</label><input id="contact-title" style={inputStyle} value={form.title} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('title', e.target.value)} /></div>
        <div><label htmlFor="contact-role" style={labelStyle}>{t('contacts.fields.role')}</label><input id="contact-role" style={inputStyle} value={form.role} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('role', e.target.value)} /></div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="contact-nickname" style={labelStyle}>{t('contacts.fields.nickname')}</label>
        <input id="contact-nickname" style={inputStyle} value={form.nickname} onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('nickname', e.target.value)} />
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.dates')}</label>
        {form.contactDates.map((date, index) => {
          const preset = ['Birthday', 'Anniversary', 'Name day'].includes(date.label) ? date.label : 'custom';
          return <div key={index} style={{ display: 'grid', gridTemplateColumns: preset === 'custom' ? '120px 1fr 1fr auto' : '120px 1fr auto', gap: 6, marginBottom: 6 }}>
            <select value={preset} onChange={event => onSetCollection('contactDates', index, 'label', event.target.value === 'custom' ? '' : event.target.value)} style={inputStyle}>
              <option value="Birthday">{t('contacts.fields.birthday')}</option>
              <option value="Anniversary">{t('contacts.fields.anniversary')}</option>
              <option value="Name day">{t('contacts.fields.nameDay')}</option>
              <option value="custom">{t('contacts.fields.customDate')}</option>
            </select>
            {preset === 'custom' && <input style={inputStyle} value={date.label} placeholder={t('contacts.fields.customDate')} onChange={event => onSetCollection('contactDates', index, 'label', event.target.value)} />}
            <input type={date.value.startsWith('--') ? 'text' : 'date'} pattern={date.value.startsWith('--') ? '--[0-9]{2}-[0-9]{2}' : undefined} style={inputStyle} value={date.value} onChange={event => onSetCollection('contactDates', index, 'value', event.target.value)} />
            <ContactDangerButton onClick={() => onRemoveCollection('contactDates', index)} aria-label={`${t('common.delete')} ${t('contacts.fields.dates')} ${index + 1}`}>{t('common.delete')}</ContactDangerButton>
          </div>;
        })}
        <button onClick={() => onAddCollection('contactDates', { label: 'Birthday', value: '' })} style={addFieldBtn}>+ {t('contacts.addDate')}</button>
      </div>

      {/* Emails */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.email')}</label>
        {form.emails.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="email"
              value={e.value}
              placeholder="email@example.com"
              onChange={ev => onSetEmail(i, 'value', ev.target.value)}
            />
            <select
              value={e.type}
              onChange={ev => onSetEmail(i, 'type', ev.target.value)}
              style={{ ...inputStyle, width: 80, padding: '8px 6px' }}
            >
              <option value="other">{t('contacts.emailTypes.other')}</option>
              <option value="work">{t('contacts.emailTypes.work')}</option>
              <option value="home">{t('contacts.emailTypes.home')}</option>
            </select>
            {form.emails.length > 1 && (
              <ContactDangerButton onClick={() => onRemoveEmail(i)} aria-label={`${t('common.delete')} ${t('contacts.fields.email')} ${i + 1}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </ContactDangerButton>
            )}
          </div>
        ))}
        <button onClick={onAddEmail} style={addFieldBtn}>+ {t('contacts.addEmail')}</button>
      </div>

      {/* Phones */}
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('contacts.fields.phone')}</label>
        {form.phones.map((p, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              style={{ ...inputStyle, flex: 1 }}
              type="tel"
              value={p.value}
              placeholder="+1 555 000 0000"
              onChange={ev => onSetPhone(i, 'value', ev.target.value)}
            />
            <select
              value={p.type}
              onChange={ev => onSetPhone(i, 'type', ev.target.value)}
              style={{ ...inputStyle, width: 90, padding: '8px 6px' }}
            >
              <option value="mobile">{t('contacts.phoneTypes.mobile')}</option>
              <option value="work">{t('contacts.phoneTypes.work')}</option>
              <option value="home">{t('contacts.phoneTypes.home')}</option>
              <option value="other">{t('contacts.phoneTypes.other')}</option>
            </select>
            <ContactDangerButton onClick={() => onRemovePhone(i)} aria-label={`${t('common.delete')} ${t('contacts.fields.phone')} ${i + 1}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </ContactDangerButton>
          </div>
        ))}
        <button onClick={onAddPhone} style={addFieldBtn}>+ {t('contacts.addPhone')}</button>
      </div>

      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{t('contacts.fields.notes')}</label>
        <textarea
          rows={3}
          style={{ ...inputStyle, resize: 'vertical' }}
          value={form.notes}
          onChange={ (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onField('notes', e.target.value)}
        />
      </div>

      <ContactTextCollection label={t('contacts.fields.url')} items={form.urls} inputType="url" placeholder="https://example.com" onSet={(index, value) => onSetCollection('urls', index, 'value', value)} onAdd={() => onAddCollection('urls', { value: '', type: 'other' })} onRemove={index => onRemoveCollection('urls', index)} inputStyle={inputStyle} addLabel={t('contacts.addUrl')} removeLabel={t('common.delete')} />
      <ContactTextCollection label={t('contacts.fields.instantMessage')} items={form.instantMessages} placeholder="matrix:@name:example.com" onSet={(index, value) => onSetCollection('instantMessages', index, 'value', value)} onAdd={() => onAddCollection('instantMessages', { value: '', type: 'other' })} onRemove={index => onRemoveCollection('instantMessages', index)} inputStyle={inputStyle} addLabel={t('contacts.addInstantMessage')} removeLabel={t('common.delete')} />
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="contact-categories" style={labelStyle}>{t('contacts.fields.categories')}</label>
        <input id="contact-categories" style={inputStyle} value={form.categories.join(', ')} onChange={event => onSetCategories(event.target.value)} placeholder={t('contacts.categoriesPlaceholder')} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={labelStyle}>{t('contacts.fields.address')}</label>
        {form.addresses.map((address, index) => <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
          <input style={inputStyle} value={address.pobox} placeholder={t('contacts.fields.pobox')} onChange={event => onSetCollection('addresses', index, 'pobox', event.target.value)} />
          <input style={inputStyle} value={address.extended} placeholder={t('contacts.fields.extended')} onChange={event => onSetCollection('addresses', index, 'extended', event.target.value)} />
          <input style={inputStyle} value={address.street} placeholder={t('contacts.fields.street')} onChange={event => onSetCollection('addresses', index, 'street', event.target.value)} />
          <input style={inputStyle} value={address.locality} placeholder={t('contacts.fields.locality')} onChange={event => onSetCollection('addresses', index, 'locality', event.target.value)} />
          <input style={inputStyle} value={address.region} placeholder={t('contacts.fields.region')} onChange={event => onSetCollection('addresses', index, 'region', event.target.value)} />
          <input style={inputStyle} value={address.postalCode} placeholder={t('contacts.fields.postalCode')} onChange={event => onSetCollection('addresses', index, 'postalCode', event.target.value)} />
          <input style={inputStyle} value={address.country} placeholder={t('contacts.fields.country')} onChange={event => onSetCollection('addresses', index, 'country', event.target.value)} />
          <ContactDangerButton onClick={() => onRemoveCollection('addresses', index)} aria-label={`${t('common.delete')} ${t('contacts.fields.address')} ${index + 1}`}>{t('common.delete')}</ContactDangerButton>
        </div>)}
        <button onClick={() => onAddCollection('addresses', { type: 'other', pobox: '', extended: '', street: '', locality: '', region: '', postalCode: '', country: '' })} style={addFieldBtn}>+ {t('contacts.addAddress')}</button>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            background: 'var(--accent)', border: 'none', borderRadius: 7,
            color: 'var(--accent-text)', fontSize: 13, fontWeight: 500,
            padding: '8px 20px', cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        <ActionBtn onClick={onCancel} disabled={saving}>{t('common.cancel')}</ActionBtn>
      </div>
    </div>
  );
}

/** An editable list of single-value contact entries (urls, instant messages). */
interface ContactTextCollectionProps {
  label: string;
  items: Array<{ value?: string; type?: string; [key: string]: unknown }>;
  inputType?: string;
  placeholder?: string;
  onSet: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  inputStyle?: CSSProperties;
  addLabel?: string;
  removeLabel?: string;
}

function ContactTextCollection({ label, items, inputType = 'text', placeholder, onSet, onAdd, onRemove, inputStyle, addLabel, removeLabel }: ContactTextCollectionProps) {
  return <div style={{ marginBottom: 12 }}>
    <label style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 4, display: 'block' }}>{label}</label>
    {items.map((item, index) => <div key={index} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
      <input type={inputType} style={{ ...inputStyle, flex: 1 }} value={item.value} placeholder={placeholder} onChange={event => onSet(index, event.target.value)} />
      <ContactDangerButton onClick={() => onRemove(index)} aria-label={`${removeLabel} ${label} ${index + 1}`}>{'×'}</ContactDangerButton>
    </div>)}
    <button onClick={onAdd} style={addFieldBtn}>+ {addLabel}</button>
  </div>;
}

// Detail sections follow the mock-up: hairline-separated groups with a mono
// uppercase label, rows of icon + value + a mono type chip (§ contacts brief).
const detailSectionLabel = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10,
  letterSpacing: '0.09em', textTransform: 'uppercase',
  color: 'var(--text-tertiary)', margin: '0 0 7px',
};
const detailTypeChip = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 9.5,
  color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)',
  borderRadius: 4, padding: '0 5px', flexShrink: 0, whiteSpace: 'nowrap',
};
const contactStatChip = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11,
  fontFamily: 'var(--font-mono, ui-monospace, monospace)', borderRadius: 999,
  padding: '2px 9px', border: '1px solid var(--border-subtle)',
  color: 'var(--text-secondary)', whiteSpace: 'nowrap',
};
const detailNote = { margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 };
const rowTypeChip = { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 10, color: 'var(--text-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' };

// Feather-style field icons (15px, stroke 1.75, currentColor) for detail rows.
const fieldIcon = {
  mail: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/></svg>,
  phone: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>,
  globe: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>,
  message: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>,
  mapPin: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>,
  calendar: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  briefcase: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/></svg>,
};

function DetailSection({ label = undefined, children }: { label?: string; children?: React.ReactNode }) {
  return (
    <section style={{
      borderTop: '1px solid var(--border-subtle)',
      padding: '12px 0', marginBottom: 2,
    }}>
      {label && <div style={detailSectionLabel}>{label}</div>}
      {children}
    </section>
  );
}

function DetailRow({ icon, type, children }: { icon?: React.ReactNode; type?: string; children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0',
      fontSize: 13,
    }}>
      {icon && <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, display: 'inline-flex' }} aria-hidden="true">{icon}</span>}
      <span style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{children}</span>
      {type && <span style={detailTypeChip}>{type}</span>}
    </div>
  );
}

interface ActionBtnProps { children?: React.ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }
function ActionBtn({ children, onClick, danger = false, disabled = false }: ActionBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`btn-press${danger ? ' contacts-danger-btn' : ''}`}
      style={{
        background: danger ? (disabled ? 'rgba(148, 163, 184, 0.16)' : 'transparent') : 'var(--bg-tertiary)',
        border: danger ? `1px solid ${disabled ? 'rgba(148, 163, 184, 0.4)' : 'var(--red-border, rgba(248,113,113,0.4))'}` : '1px solid var(--border)',
        borderRadius: 7,
        color: danger ? (disabled ? '#94a3b8' : 'var(--red, #f87171)') : 'var(--text-primary)',
        fontSize: 12, fontWeight: 500,
        padding: '6px 12px', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 0.1s',
      }}
    >
      {children}
    </button>
  );
}

function ContactDangerButton({ children, onClick, disabled = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      onClick={onClick}
      disabled={disabled}
      className="contacts-danger-btn"
      style={{
        borderRadius: 6, fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '0 8px', display: 'flex', alignItems: 'center', flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {children}
    </button>
  );
}

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div role="alert" style={{
      marginBottom: 16, padding: '10px 14px', borderRadius: 8,
      background: 'var(--red-dim, rgba(248,113,113,0.1))',
      border: '1px solid var(--red-border, rgba(248,113,113,0.3))',
      fontSize: 13, color: 'var(--red, #f87171)',
    }}>
      {msg}
    </div>
  );
}

const addFieldBtn = {
  background: 'transparent',
  border: 'none',
  color: 'var(--accent)',
  fontSize: 12, cursor: 'pointer',
  padding: '2px 0',
};
