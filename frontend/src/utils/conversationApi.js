import { api } from './api.js';

export const conversationApi = {
  list: (params = {}) => api.get(`/mail/conversations?${new URLSearchParams(params)}`),
  detail: (conversationId) => api.get(`/mail/conversations/${encodeURIComponent(conversationId)}`),
  resolve: (messageId) => api.get(`/mail/messages/${encodeURIComponent(messageId)}/conversation`),
};
