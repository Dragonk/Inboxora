import { api } from './api.js';

export const conversationApi = {
  list: (params = {}) => api.get(`/mail/conversations?${new URLSearchParams(params)}`),
  detail: (conversationId) => api.get(`/mail/conversations/${encodeURIComponent(conversationId)}`),
  body: (conversationId, logicalMessageId) => api.get(`/mail/conversations/${encodeURIComponent(conversationId)}/logical-messages/${encodeURIComponent(logicalMessageId)}/body`),
  resolve: (messageId) => api.get(`/mail/messages/${encodeURIComponent(messageId)}/conversation`),
  overrides: (conversationId) => api.get(`/mail/conversations/${encodeURIComponent(conversationId)}/overrides`),
  applyOverride: (conversationId, payload) => api.post(`/mail/conversations/${encodeURIComponent(conversationId)}/overrides`, payload),
};
