import type { StoreMessageRow } from '../store/index.ts';
import type { GtdFolderMap } from './gtd.ts';
import { getAuthEpoch, isCurrentAuthEpoch } from './authEpoch.ts';

const BASE = '/api';

// Sent on every /api request so the backend CSRF guard accepts it. A cross-site
// form/navigation cannot set a custom header, and a cross-origin fetch that tries
// triggers a CORS preflight the server rejects. Any raw fetch() to /api elsewhere
// in the app must include this same header (see CSRF_HEADER).
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'MailFlow';
const messageBodyRequests = new Map();

/** Query-string parameters as callers pass them. */
/** A folder as GET /accounts/:id/folders returns it. */
export interface FolderListEntry {
  path: string;
  name?: string;
  special_use?: string | null;
  delimiter?: string | null;
  [key: string]: unknown;
}

/** A calendar event payload (updateEvent reads recurrenceId to target an occurrence). */
export interface CalendarEventPayload {
  recurrenceId?: string | null;
  [key: string]: unknown;
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface ThreadResponse {
  messages: StoreMessageRow[];
}

/** Serialise query parameters, dropping absent values. */
export function toSearchParams(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return search.toString();
}

async function request(method: string, path: string, body: unknown = undefined, extraHeaders: Record<string, string> | undefined = undefined, extraOptions: RequestInit = {}) {
  const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_VALUE, ...(extraHeaders || {}) };
  if (body) headers['Content-Type'] = 'application/json';
  const opts: RequestInit = {
    method,
    credentials: 'include',
    headers,
    ...extraOptions,
  };
  if (body) opts.body = JSON.stringify(body);
  // Capture before fetch so a late response cannot emit an auth event into a newer SPA session.
  const requestAuthEpoch = getAuthEpoch();
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    if (res.status === 423 && isCurrentAuthEpoch(requestAuthEpoch)) {
      // Server-enforced screen lock (#235) — surface the lock overlay from current-session calls only.
      window.dispatchEvent(new CustomEvent('inboxora:locked'));
    }
    if (res.status === 401 && !path.startsWith('/auth/') && isCurrentAuthEpoch(requestAuthEpoch)) {
      window.dispatchEvent(new CustomEvent('inboxora:session_expired'));
    }
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    const error = new Error(err.error || 'Request failed');
    error.status = res.status;
    if (err.source) error.source = err.source;
    if (err.sync) error.sync = err.sync;
    throw error;
  }
  // A successful DELETE may deliberately return no representation (HTTP 204).
  if (res.status === 204) return null;
  return res.json();
}

// Aborting a request rejects with a DOMException named AbortError (or, in some
// runtimes, an object carrying that name). Callers use this to tell a deliberate
// cancellation from a real failure, so a cancelled load never surfaces an error.
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('name' in error && error.name === 'AbortError') return true;
  if ('code' in error && error.code === 20) return true;
  return false;
}

export async function streamAiChat(messages: unknown[], { signal, onDelta }: { signal?: AbortSignal; onDelta?: (fullText: string, delta: string) => void } = {}) {
  const response = await fetch(`${BASE}/ai/chat`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: CSRF_VALUE },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'AI request failed' }));
    throw new Error(error.error || 'AI request failed');
  }
  if (!response.body) throw new Error('AI response body is unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let completed = false;

  function consumeLine(line: string) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      completed = true;
      return;
    }
    try {
      const parsed = JSON.parse(data);
      if (parsed?.error) {
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error.message;
        throw new Error(message || 'AI request failed');
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        fullText += delta;
        onDelta?.(fullText, delta);
      }
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  }

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        consumeLine(line);
        if (completed) break;
      }
    }
    if (!completed && buffer) consumeLine(buffer);
    if (!completed) throw new Error('AI response ended before completion');
    return fullText;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function getMessageBody(id: string, remoteImages = false, copyId: string | null = null) {
  const key = `${id}:${copyId || 'default'}:${remoteImages ? 'remote' : 'blocked'}`;
  const existing = messageBodyRequests.get(key);
  if (existing) return existing;
  const query = new URLSearchParams();
  if (remoteImages) query.set('remoteImages', '1');
  if (copyId) query.set('copyId', copyId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const promise = request('GET', `/mail/messages/${id}/body${suffix}`)
    .finally(() => messageBodyRequests.delete(key));
  messageBodyRequests.set(key, promise);
  return promise;
}

export const api = {
  get: (path: string, extraOptions = {}) => request('GET', path, undefined, undefined, extraOptions),
  post: (path: string, body: unknown, extraHeaders?: Record<string, string>) => request('POST', path, body, extraHeaders),
  put: (path: string, body: unknown) => request('PUT', path, body),
  patch: (path: string, body: unknown) => request('PATCH', path, body),
  delete: (path: string) => request('DELETE', path),

  // Auth
  login: (username: string, password: string) => request('POST', '/auth/login', { username, password }),
  register: (username: string, password: string, inviteToken: string | null) => request('POST', '/auth/register', { username, password, inviteToken }),
  logout: () => request('POST', '/auth/logout'),
  lock: () => request('POST', '/auth/lock'),
  unlock: async (pin: string) =>{
    // Custom (not request()) so we can read the lockout flag on failure: after too many
    // attempts the server destroys the session and returns { signedOut: true }; route to
    // login via session_expired rather than showing an error.
    const res = await fetch(BASE + '/auth/unlock', {
      method: 'POST', credentials: 'include',
      headers: { [CSRF_HEADER]: CSRF_VALUE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (data.signedOut) {
      window.dispatchEvent(new CustomEvent('inboxora:session_expired'));
      const e = new Error('signed_out'); e.signedOut = true; throw e;
    }
    throw new Error(data.error || 'Incorrect PIN');
  },
  setLockPin: (pin: string, currentPin?: string) => request('POST', '/auth/lock-pin', { pin, currentPin }),
  removeLockPin: (currentPin: string) => request('DELETE', '/auth/lock-pin', { currentPin }),
  me: () => request('GET', '/auth/me'),
  forgotPassword: (email: string) => request('POST', '/auth/forgot-password', { email }),
  resetPassword: (token: string, password: string) => request('POST', '/auth/reset-password', { token, password }),
  getPreferences: () => request('GET', '/auth/preferences'),
  savePreferences: (prefs: Record<string, unknown>) => request('PATCH', '/auth/preferences', prefs),
  updateProfile: (data: unknown) => request('PATCH', '/auth/profile', data),
  uploadAvatar: (avatar: unknown) => request('POST', '/auth/avatar', { avatar }),
  deleteAvatar: () => request('DELETE', '/auth/avatar'),
  getRegistrationStatus: () => request('GET', '/auth/registration-status'),
  validateInvite: (token: string) => request('GET', `/auth/invite/${token}`),

  // Recovery email (profile security)
  getRecoveryEmail: () => request('GET', '/auth/profile/recovery-email'),
  updateRecoveryEmail: (email: string | null) => request('PATCH', '/auth/profile/recovery-email', { email }),

  // TOTP / 2FA
  totp: {
    setup: () => request('GET', '/totp/setup'),
    enable: (code: string) => request('POST', '/totp/enable', { code }),
    disable: (password: string) => request('POST', '/totp/disable', { password }),
    cancel: () => request('POST', '/totp/cancel'),
    challenge: (code: string, rememberDevice: boolean) => request('POST', '/auth/2fa/challenge', { code, rememberDevice }),
    sendEmailOtp: () => request('POST', '/auth/2fa/send-email-otp'),
    verifyEmailOtp: (code: string, rememberDevice: boolean) => request('POST', '/auth/2fa/verify-email-otp', { code, rememberDevice }),
    enrollmentSetup: () => request('GET', '/auth/2fa/enrollment/setup'),
    enrollmentEnable: (code: string) => request('POST', '/auth/2fa/enrollment/enable', { code }),
  },

  // Admin
  admin: {
    getUsers: (params: QueryParams) => request('GET', '/admin/users' + (params ? '?' + toSearchParams(params) : '')),
    updateUser: (id: string, data: unknown) => request('PATCH', `/admin/users/${id}`, data),
    deleteUser: (id: string) => request('DELETE', `/admin/users/${id}`),
    disableUserTotp: (id: string) => request('POST', `/admin/users/${id}/totp/disable`),
    getSettings: () => request('GET', '/admin/settings'),
    updateSettings: (data: unknown) => request('PATCH', '/admin/settings', data),
    getInvites: (params: QueryParams) => request('GET', '/admin/invites' + (params ? '?' + toSearchParams(params) : '')),
    createInvite: (email: string) => request('POST', '/admin/invites', { email }),
    deleteInvite: (id: string) => request('DELETE', `/admin/invites/${id}`),
    getSystemEmail: () => request('GET', '/admin/system-email'),
    saveSystemEmail: (data: unknown) => request('POST', '/admin/system-email', data),
    testSystemEmail: () => request('POST', '/admin/system-email/test'),
    deleteSystemEmail: () => request('DELETE', '/admin/system-email'),
    getAuthEvents: (params: QueryParams) => request('GET', '/admin/auth-events?' + toSearchParams(params)),
    oidc: {
      getProviders: () => request('GET', '/admin/oidc'),
      createProvider: (data: unknown) => request('POST', '/admin/oidc', data),
      updateProvider: (id: string, data: unknown) => request('PATCH', `/admin/oidc/${id}`, data),
      deleteProvider: (id: string) => request('DELETE', `/admin/oidc/${id}`),
    },
  },

  // OIDC
  oidc: {
    getProviders: () => request('GET', '/auth/oidc/providers'),
    getIdentities: () => request('GET', '/auth/oidc/identities'),
    unlinkIdentity: (id: string) => request('DELETE', `/auth/oidc/identities/${id}`),
  },

  // Accounts
  getAccounts: () => request('GET', '/accounts'),
  addAccount: (data: unknown) => request('POST', '/accounts', data),
  updateAccount: (id: string, data: unknown) => request('PUT', `/accounts/${id}`, data),
  deleteAccount: (id: string) => request('DELETE', `/accounts/${id}`),
  reconnectAccount: (id: string) => request('POST', `/accounts/${id}/reconnect`),
  reindexAccount: (id: string) => request('POST', `/accounts/${id}/reindex`),
  getFolders: (accountId: string) => request('GET', `/accounts/${accountId}/folders`),
  getAliases: (accountId: string) => request('GET', `/accounts/${accountId}/aliases`),
  addAlias: (accountId: string, data: unknown) => request('POST', `/accounts/${accountId}/aliases`, data),
  updateAlias: (accountId: string, aliasId: string, data: unknown) => request('PUT', `/accounts/${accountId}/aliases/${aliasId}`, data),
  deleteAlias: (accountId: string, aliasId: string) => request('DELETE', `/accounts/${accountId}/aliases/${aliasId}`),

  // Mail
  getMessages: (params: QueryParams) =>{
    const qs = toSearchParams(params);
    return request('GET', `/mail/messages?${qs}`);
  },
  getMessage: (id: string) => request('GET', `/mail/messages/${id}`),
  // Resolve a deep-link reference (stable Message-ID header, or a legacy UUID) to the
  // current message row — durable across folder moves (#270).
  resolveMessage: (ref: string, accountId: string | undefined = undefined) => {
    const qs = new URLSearchParams({ ref });
    if (accountId) qs.set('accountId', accountId);
    return request('GET', `/mail/resolve-message?${qs}`);
  },
  getMessageBody,
  getThread: (threadId: string, folder: string, unified = false, accountId: string | null = null): Promise<ThreadResponse> =>{
    const qs = new URLSearchParams();
    if (folder) qs.set('folder', folder);
    if (unified) qs.set('unified', 'true');
    if (accountId) qs.set('accountId', accountId);
    const query = qs.size ? `?${qs}` : '';
    return request('GET', `/mail/thread/${encodeURIComponent(threadId)}${query}`);
  },
  bulkRead: (ids: string[], read: boolean) => request('POST', '/mail/messages/bulk-read', { ids, read }),
  markStarred: (id: string, starred: boolean) => request('PATCH', `/mail/messages/${id}/star`, { starred }),
  markAllRead: (accountId: string, folder: string) => request('POST', '/mail/mark-all-read', { accountId, folder }),
  deleteMessage: (id: string) => request('DELETE', `/mail/messages/${id}`),
  bulkDelete: (ids: string[]) => request('POST', '/mail/messages/bulk-delete', { ids }),
  bulkMove: (ids: string[], folder: string) => request('POST', '/mail/messages/bulk-move', { ids, folder }),
  bulkArchive: (ids: string[]) => request('POST', '/mail/messages/bulk-archive', { ids }),
  getUnreadCounts: () => request('GET', '/mail/unread-counts'),

  // Mailbox cleanup (read-only analysis; actual cleanup reuses bulkDelete above).
  mailboxUsage: (accountId: string) => request('GET', `/mail/mailbox-usage?accountId=${encodeURIComponent(accountId)}`),
  cleanupPreview: (accountId: string, fromEmail: string) =>
    request('GET', `/mail/cleanup-preview?accountId=${encodeURIComponent(accountId)}&fromEmail=${encodeURIComponent(fromEmail)}`),

  // Antispam (v0.1) — manual user feedback.
  // markSpam moves the message to the account's spam/junk folder and
  // records the decision in spam_training_log. markHam moves it back to
  // INBOX. No automatic classification runs here yet.
  markSpam: (id: string) => request('POST', `/mail/messages/${id}/spam`),
  markHam:  (id: string) => request('POST', `/mail/messages/${id}/ham`),

  getMessageHeaders: (id: string) => request('GET', `/mail/messages/${id}/headers`),
  snoozeMessage: (id: string, until: unknown) => request('POST', `/mail/messages/${id}/snooze`, { until }),

  // Sanitized diagnostics report (server-owned sections; scoped to the user).
  diagnosticsReport: (salt: string) => request('POST', '/diagnostics/report', { salt }),

  // Integrations
  getIntegrations: () => request('GET', '/integrations'),
  getIntegrationsStatus: () => request('GET', '/integrations/status'),
  saveIntegration: (provider: string, config: unknown) => request('POST', `/integrations/${provider}`, config),
  deleteIntegration: (provider: string) => request('DELETE', `/integrations/${provider}`),
  startMsDeviceFlow: async () => {
    const res = await fetch('/oauth/microsoft/device', { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start device code flow');
    return data;
  },
  pollMsDeviceFlow: async () => {
    const res = await fetch('/oauth/microsoft/device/poll', { credentials: 'include' });
    return res.json();
  },

  // Sync
  syncNow: (accountId?: string | undefined) => request('POST', '/mail/sync', accountId ? { accountId } : {}),
  syncFolder: (accountId: string, folder: string) => request('POST', '/mail/sync-folder', { accountId, folder }),
  syncFoldersNow: (accountId: string) => request('POST', '/mail/sync-folders', accountId ? { accountId } : {}),

  // Folder management
  createFolder: (accountId: string, name: string, parentPath: string | null | undefined) => request('POST', '/mail/folders', { accountId, name, parentPath }),
  deleteFolder: (accountId: string, path: string) => request('POST', '/mail/folders/delete', { accountId, path }),
  renameFolder: (accountId: string, oldPath: string, newName: string) => request('POST', '/mail/folders/rename', { accountId, oldPath, newName }),
  emptyFolder: (accountId: string, path: string) => request('POST', '/mail/folders/empty', { accountId, path }),

  // Search
  search: (q: string, accountId?: string | undefined, { offset = 0, limit, folder }: { offset?: number; limit?: string | number; folder?: string } = {}) =>{
    const params = new URLSearchParams({ q });
    if (accountId) params.set('accountId', accountId);
    if (limit) params.set('limit', String(limit));
    if (folder) params.set('folder', folder);
    if (offset) params.set('offset', String(offset));
    return request('GET', `/search?${params}`);
  },
  suggestContacts: (q: string) => request('GET', `/search/contacts?q=${encodeURIComponent(q)}`),

  // Contacts
  getContacts:   ({ q, limit, offset, is_auto, addressBookId }: { q?: string; limit?: string | number; offset?: string | number; is_auto?: string | boolean; addressBookId?: string } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (limit !== undefined) p.set('limit', String(limit));
    if (offset !== undefined) p.set('offset', String(offset));
    if (is_auto !== undefined) p.set('is_auto', String(is_auto));
    if (addressBookId) p.set('addressBookId', addressBookId);
    const qs = p.toString();
    return request('GET', `/contacts${qs ? '?' + qs : ''}`);
  },
  getContact:    (id: string)       => request('GET',    `/contacts/${id}`),
  createContact: (data: unknown)     => request('POST',   '/contacts', data),
  updateContact: (id: string, data: unknown) => request('PATCH',  `/contacts/${id}`, data),
  deleteContact: (id: string)       => request('DELETE', `/contacts/${id}`),
  addressBooks: {
    list: () => request('GET', '/contacts/address-books'),
    create: (name: string) => request('POST', '/contacts/address-books', { name }),
    update: (id: string, data: unknown) => request('PATCH', `/contacts/address-books/${encodeURIComponent(id)}`, data),
    remove: (id: string) => request('DELETE', `/contacts/address-books/${encodeURIComponent(id)}`),
    importGoogleCsv: (id: string, csv: string) => request('POST', `/contacts/address-books/${encodeURIComponent(id)}/import/google-csv`, { csv }),
    exportUrl: (id: string, format: string) =>`${BASE}/contacts/address-books/${encodeURIComponent(id)}/export?format=${encodeURIComponent(format)}`,
  },

  // CardDAV contact sync (Nextcloud etc.)
  carddav: {
    status:     ()     => request('GET',    '/carddav'),
    connect:    (data: unknown) => request('POST',   '/carddav/connect', data),
    update:     (data: unknown) => request('PATCH',  '/carddav', data),
    sync:       ()     => request('POST',   '/carddav/sync'),
    disconnect: ()     => request('DELETE', '/carddav'),
  },

  // DAV Hub — dedicated, revocable app passwords for CardDAV/CalDAV clients.
  davCredentials: {
    list:   () => request('GET', '/dav-credentials'),
    create: (label: string) => request('POST', '/dav-credentials', { label }),
    revoke: (id: string) => request('DELETE', `/dav-credentials/${id}`),
  },

  // Local calendar resources shared with the built-in CalDAV service.
  calendar: {
    getInvitation: (id: string) => request('GET', `/calendar/invitations/${encodeURIComponent(id)}`),
    addInvitation: (id: string, calendarId: string) => request('POST', `/calendar/invitations/${encodeURIComponent(id)}`, { calendarId }),
    removeInvitation: (id: string) => request('DELETE', `/calendar/invitations/${encodeURIComponent(id)}`),
    listCalendars: ({ signal }: { signal?: AbortSignal } = {}) => request('GET', '/calendar/calendars', undefined, undefined, { signal }),
    updateCalendar: (id: string, data: unknown) => request('PATCH', `/calendar/calendars/${encodeURIComponent(id)}`, data),
    deleteCalendar: (id: string, confirmName: string) => request('DELETE', `/calendar/calendars/${encodeURIComponent(id)}`, { confirmName }),
    // Reads accept an AbortSignal so a superseded range or an unmounting page can
    // cancel work the user no longer needs. `calendarIds` narrows the expansion
    // server-side; `null` means every calendar, `[]` means none.
    listEvents: (from: string, to: string, { signal, calendarIds }: { signal?: AbortSignal; calendarIds?: string[] | null } = {}) => {
      const params = new URLSearchParams({ from, to });
      if (Array.isArray(calendarIds)) params.set('calendarIds', calendarIds.join(','));
      return request('GET', `/calendar/events?${params}`, undefined, undefined, { signal });
    },
    createEvent: (data: CalendarEventPayload, idempotencyKey: string | undefined = undefined) => request('POST', '/calendar/events', data, idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined),
    updateEvent: (id: string, data: CalendarEventPayload, idempotencyKey: string | undefined = undefined) => request('PATCH', `/calendar/events/${id}${data.recurrenceId ? '/occurrence' : ''}`, data, idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : undefined),
    getCancellationDelivery: (id: string, { signal }: { signal?: AbortSignal } = {}) => request('GET', `/calendar/events/${encodeURIComponent(id)}/cancellation-delivery`, undefined, undefined, { signal }),
    retryCancellationDelivery: (id: string) => request('POST', `/calendar/events/${encodeURIComponent(id)}/cancellation-delivery/retry`),
    // scope 'following' ends the series just before this occurrence; with no recurrenceId the
    // whole event is removed. Removing an entire series goes through the plain event DELETE,
    // which is also the path that notifies invited attendees.
    deleteEvent: (id: string, calendarId: string, recurrenceId: string | null | undefined = undefined, scope: string | null | undefined = undefined) =>recurrenceId ? request('DELETE', `/calendar/events/${encodeURIComponent(id)}/occurrence`, { calendarId, recurrenceId, ...(scope ? { scope } : {}) }) : request('DELETE', `/calendar/events/${encodeURIComponent(id)}?calendarId=${encodeURIComponent(calendarId)}`),
    listSources: () => request('GET', '/calendar/sources'),
    createSource: (data: unknown) => request('POST', '/calendar/sources', data),
    updateSource: (id: string, data: unknown) => request('PATCH', `/calendar/sources/${encodeURIComponent(id)}`, data),
    syncSource: (id: string) => request('POST', `/calendar/sources/${encodeURIComponent(id)}/sync`),
    deleteSource: (id: string) => request('DELETE', `/calendar/sources/${encodeURIComponent(id)}`),
  },

  // Image whitelist
  addToImageWhitelist: (entry: Record<string, unknown>) => request('POST', '/auth/preferences/whitelist-add', entry),

  // Web Push
  getPushVapidKey:  ()           => request('GET',    '/auth/push/vapid-key'),
  pushSubscribe:    (subscription: PushSubscriptionJSON) => request('POST',   '/auth/push/subscribe',    subscription),
  pushUnsubscribe:  (body: unknown)       => request('POST',    '/auth/push/unsubscribe',   body),

  // Native (Android) push device registry. Registration is normally driven from
  // the native layer (it owns the provider endpoint/token); these calls back the
  // settings UI and the logout path.
  getPushStatus:        ()         => request('GET',    '/push/status'),
  listPushDevices:      ()         => request('GET',    '/push/devices'),
  removePushDevice:     (deviceId: string) => request('DELETE', `/push/devices/${encodeURIComponent(deviceId)}`),
  removeAllPushDevices: ()         => request('DELETE', '/push/devices'),

  // Inbox Rules
  getRules:    ()         => request('GET',    '/rules'),
  createRule:  (data: unknown)     => request('POST',   '/rules', data),
  updateRule:  (id: string, data: unknown) => request('PUT',    `/rules/${id}`, data),
  deleteRule:  (id: string)       => request('DELETE', `/rules/${id}`),
  reorderRules:(ids: string[])      => request('PATCH',  '/rules/reorder', { ids }),
  runRules:    (accountId: string | undefined = undefined) => request('POST',  '/rules/run', accountId ? { accountId } : {}),

  // Drafts
  saveDraft:   (data: unknown)              => request('POST',   '/mail/draft', data),
  deleteDraft: (accountId: string, uid: number, folder: string, uidValidity: number) =>
    request('DELETE', `/mail/draft/${uid}?accountId=${encodeURIComponent(accountId)}&folder=${encodeURIComponent(folder)}&uidValidity=${encodeURIComponent(uidValidity)}`),

  // Block List
  getBlockList:          ()      => request('GET',    '/block-list'),
  addToBlockList:        (email: string) => request('POST',   '/block-list', { emailAddress: email }),
  removeFromBlockList:   (id: string)    => request('DELETE', `/block-list/${id}`),

  // AI assistant
  ai: {
    getConfig: () => request('GET', '/admin/ai'),
    saveConfig: (data: unknown) => request('PATCH', '/admin/ai', data),
    deleteConfig: () => request('DELETE', '/admin/ai'),
    test: () => request('POST', '/admin/ai/test'),
    status: () => request('GET', '/ai/status'),
    chat: streamAiChat,
    codex: {
      start: () => request('POST', '/admin/ai/codex/device'),
      poll: (flowId: string) => request('POST', '/admin/ai/codex/device/poll', { flowId }),
      status: () => request('GET', '/admin/ai/codex/status'),
      cancel: (flowId: string) => request('DELETE', '/admin/ai/codex/device', { flowId }),
      disconnect: () => request('DELETE', '/admin/ai/codex'),
    },
  },

  // Category counts for inbox tab badges
  getCategoryCounts: (params: QueryParams) =>{
    const qs = toSearchParams(params || {});
    return request('GET', `/mail/category-counts${qs ? '?' + qs : ''}`);
  },

  // Manual category override for a single message
  setMessageCategory: (id: string, category: unknown) => request('PATCH', `/mail/messages/${id}/category`, { category }),

  // Trigger unsubscribe for a newsletter message
  unsubscribeMessage: (id: string) => request('POST', `/mail/messages/${id}/unsubscribe`),

  // Email categorization
  categories: {
    getSources: () => request('GET', '/categories/sources'),
    addSource: (data: unknown) => request('POST', '/categories/sources', data),
    toggleSource: (id: string, enabled: boolean) => request('PATCH', `/categories/sources/${id}`, { enabled }),
    deleteSource: (id: string) => request('DELETE', `/categories/sources/${id}`),
    refreshSource: (id: string) => request('POST', `/categories/sources/${id}/refresh`),
    recategorize: (accountId: string) => request('POST', `/categories/recategorize/${accountId}`),
    aiClassify: (messageId: string) => request('POST', `/categories/ai-classify/${messageId}`),
  },

  // GTD — sections feed (rail + tabs) and classify/unclassify (COPY / remove copy)
  getGtdSections: (params: QueryParams) =>{
    const p = new URLSearchParams();
    if (params?.accountId) p.set('accountId', String(params.accountId));
    if (params?.limit != null) p.set('limit', String(params.limit));
    const qs = p.toString();
    return request('GET', `/gtd/sections${qs ? '?' + qs : ''}`);
  },
  gtdClassify: (messageId: string, state: string) => request('POST', '/gtd/classify', { messageId, state }),
  gtdUndoClassify: (undoToken: unknown) => request('POST', '/gtd/classify/undo', undoToken),
  gtdUnclassify: (messageId: string, state: string) => request('DELETE', '/gtd/classify', { messageId, state }),
  // GTD "done": strip the row's label(s) for these states, mark read, archive the INBOX
  // copy. id is the rail head's row id (its label-folder copy); the server resolves the
  // INBOX copy from the shared Message-ID.
  gtdDone: (id: string, states: string[] | undefined = undefined) => request('POST', '/gtd/done', { id, states }),
  gtdEnsureFolders: (accountId: string, folders: GtdFolderMap) => request('POST', '/gtd/folders/ensure', { accountId, folders }),

  // GTD — Inbox-Zero pet. Import uploads your own pet (pet.json text + a base64 spritesheet)
  // and caches it server-side; meta returns the animation descriptor; the sheet URL is used
  // directly as an <img>/background src (authenticated same-origin, cookies ride along).
  importGtdPet: (payload: unknown) => request('POST', '/gtd/pet/import', payload),
  getGtdPetMeta: (slug: string) => request('GET', `/gtd/pet/${encodeURIComponent(slug)}/meta`),
  gtdPetSheetUrl: (slug: string) => `${BASE}/gtd/pet/${encodeURIComponent(slug)}/sheet`,

  // Plugins — registered plugins for this build plus the user's per-user activation. Activation is
  // independent of a plugin's own per-account config (e.g. GTD's gtd_enabled).
  plugins: {
    list: () => request('GET', '/plugins'),
    setActivated: (id: string, activated: boolean) => request('PATCH', `/plugins/${encodeURIComponent(id)}`, { activated }),
  },

  // Todoist integration
  todoist: {
    status:       ()       => request('GET',    '/todoist/status'),
    connect:      (token: string)  => request('POST',   '/todoist/connect', { token }),
    disconnect:   ()       => request('DELETE', '/todoist/disconnect'),
    getProjects:  ()       => request('GET',    '/todoist/projects'),
    getLabels:    ()       => request('GET',    '/todoist/labels'),
    createTask:   (data: unknown)   => request('POST',   '/todoist/tasks', data),
  },
};
