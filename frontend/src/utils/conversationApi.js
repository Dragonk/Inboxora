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
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    return apiFetch(`/conversations?${qs.toString()}`);
  },

  detail: (conversationId) => apiFetch(`/conversations/${conversationId}`),

  body: (conversationId, logicalMessageId, signal) =>
    apiFetch(`/conversations/${conversationId}/logical-messages/${logicalMessageId}/body`, { signal }),

  resolveMessage: (messageId) => apiFetch(`/messages/${messageId}/conversation`),

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
