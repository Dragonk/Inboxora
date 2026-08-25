// Conversation Engine v2 API client
const API_BASE = '/api/mail';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const conversationApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.accountId) qs.set('accountId', params.accountId);
    if (params.folder) qs.set('folder', params.folder);
    if (params.search) qs.set('search', params.search);
    if (params.unreadOnly) qs.set('unreadOnly', '1');
    if (params.category && params.category !== 'all') qs.set('category', params.category);
    if (params.pageSize || params.limit) qs.set('limit', String(params.pageSize || params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    if (params.unifiedInbox) qs.set('unifiedInbox', '1');
    if (params.searchAllFolders) qs.set('searchAllFolders', '1');
    return apiFetch(`/conversations?${qs.toString()}`);
  },

  detail: (conversationId) => apiFetch(`/conversations/${conversationId}`),

  body: (conversationId, logicalMessageId, signal, copyId = null, remoteImages = false) => {
    const qs = new URLSearchParams();
    if (copyId) qs.set('copyId', copyId);
    if (remoteImages) qs.set('remoteImages', '1');
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/body${query}`, {
      signal,
      headers: remoteImages ? { 'X-MailFlow-Image-Opt-In': '1' } : undefined,
    });
  },

  resolveMessage: (messageId) => apiFetch(`/messages/${messageId}/conversation`),

  // Copy-aware destructive actions — `scope` is explicit (never defaults to whole conversation).
  // Scopes: THIS_COPY | ALL_COPIES_OF_LOGICAL_MESSAGE | COPIES_ON_THIS_ACCOUNT | WHOLE_CONVERSATION
  archive: (conversationId, { scope = 'THIS_COPY', copyId = null, logicalMessageId = null } = {}) =>
    apiFetch(`/conversations/${conversationId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ scope, copyId, logicalMessageId }),
    }),

  move: (conversationId, targetFolder, { scope = 'THIS_COPY', copyId = null, logicalMessageId = null, items = null } = {}) => {
    const ids = Array.isArray(conversationId) ? conversationId : null;
    return apiFetch(ids ? '/conversations/bulk-move' : `/conversations/${conversationId}/move`, {
      method: 'POST',
      body: JSON.stringify(ids ? { conversationIds: ids, items, targetFolder, scope } : { targetFolder, scope, copyId, logicalMessageId }),
    });
  },

  delete: (conversationId, { scope = 'THIS_COPY', copyId = null, logicalMessageId = null } = {}) =>
    apiFetch(`/conversations/${conversationId}/delete`, {
      method: 'POST',
      body: JSON.stringify({ scope, copyId, logicalMessageId }),
    }),

  setRead: (conversationId, isRead, { scope = 'THIS_COPY', copyId = null, logicalMessageId = null } = {}) =>
    apiFetch(`/conversations/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ isRead, scope, copyId, logicalMessageId }),
    }),

  setStarred: (conversationId, isStarred, { scope = 'THIS_COPY', copyId = null, logicalMessageId = null } = {}) =>
    apiFetch(`/conversations/${conversationId}/star`, {
      method: 'POST',
      body: JSON.stringify({ isStarred, scope, copyId, logicalMessageId }),
    }),

  // Bulk variants — operate on multiple conversations at once.
  bulkArchive: (conversationIds, { scope = 'THIS_COPY', items = null } = {}) =>
    apiFetch(`/conversations/bulk-archive`, {
      method: 'POST',
      body: JSON.stringify({ conversationIds, items, scope }),
    }),

  bulkDelete: (conversationIds, { scope = 'THIS_COPY', items = null } = {}) =>
    apiFetch(`/conversations/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ conversationIds, items, scope }),
    }),

  bulkSetRead: (conversationIds, isRead, { scope = 'THIS_COPY', items = null } = {}) =>
    apiFetch(`/conversations/bulk-read`, {
      method: 'POST',
      body: JSON.stringify({ conversationIds, items, isRead, scope }),
    }),

  // Manual operations
  merge: (sourceId, targetId) =>
    apiFetch(`/conversations/${sourceId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ targetConversationId: targetId }),
    }),

  split: (conversationId, logicalMessageId, { includeReplies = false } = {}) =>
    apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/split`, {
      method: 'POST',
      body: JSON.stringify({ includeReplies }),
    }),

  moveLogicalMessage: (conversationId, logicalMessageId, targetConversationId) =>
    apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/move`, {
      method: 'POST',
      body: JSON.stringify({ targetConversationId }),
    }),

  lock: (conversationId) =>
    apiFetch(`/conversations/${conversationId}/lock`, { method: 'POST' }),

  unlock: (conversationId) =>
    apiFetch(`/conversations/${conversationId}/unlock`, { method: 'POST' }),

  forceInclude: (conversationId, logicalMessageId) =>
    apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/force-include`, { method: 'POST' }),

  forceExclude: (conversationId, logicalMessageId) =>
    apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/force-exclude`, { method: 'POST' }),

  // Diagnostics
  diagnostics: (conversationId) => apiFetch(`/conversations/${conversationId}/diagnostics`),

  // Rebuild
  rebuild: ({ dryRun = false, scope = 'all' } = {}) =>
    apiFetch(`/conversations/rebuild`, {
      method: 'POST',
      body: JSON.stringify({ dryRun, scope }),
    }),

  rebuildStatus: (jobId) => apiFetch(`/conversations/rebuild/${jobId}`),
};
