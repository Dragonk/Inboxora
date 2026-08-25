import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import ConversationMessage from './ConversationMessage.jsx';

// Data-only CE adapter. It owns logical/physical identity and expansion policy;
// MessagePane owns the pane geometry and ConversationMessage uses MessagePane visuals.
export default function ConversationReader({ conversationId, targetLogicalMessageId = null, onReply }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [bodies, setBodies] = useState({});
  const [bodyStatus, setBodyStatus] = useState({});
  const aborters = useRef(new Map());

  useEffect(() => {
    let active = true;
    setData(null); setError(null); setBodies({}); setBodyStatus({}); setExpanded(new Set());
    conversationApi.detail(conversationId).then(result => {
      if (!active) return;
      const messages = result.logicalMessages || [];
      const newest = messages.at(-1)?.id;
      const unread = messages.filter(message => message.copies?.some(copy => !copy.isRead)).map(message => message.id);
      setExpanded(new Set([newest, targetLogicalMessageId, ...unread].filter(Boolean)));
      setData(result);
    }).catch(reason => active && setError(reason.message || t('conversation.loadFailed')));
    const controllers = aborters.current;
    return () => { active = false; for (const controller of controllers.values()) controller.abort(); controllers.clear(); };
  }, [conversationId, targetLogicalMessageId, t]);

  const messages = useMemo(() => data?.logicalMessages || [], [data]);
  const loadBody = useCallback((logicalId, force = false, remoteImages = false) => {
    if (!force && (bodies[logicalId] || bodyStatus[logicalId]?.loading)) return Promise.resolve();
    aborters.current.get(logicalId)?.abort();
    const controller = new AbortController(); aborters.current.set(logicalId, controller);
    const logical = messages.find(item => item.id === logicalId);
    const copy = [...(logical?.copies || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: true } }));
    return conversationApi.body(conversationId, logicalId, controller.signal, copy?.id, remoteImages)
      .then(body => { if (!controller.signal.aborted) { setBodies(previous => ({ ...previous, [logicalId]: body })); setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false } })); } })
      .catch(reason => { if (reason.name !== 'AbortError') setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, error: reason.message || t('conversation.loadBodyFailed') } })); });
  }, [bodies, bodyStatus, conversationId, messages, t]);
  useEffect(() => { for (const id of expanded) loadBody(id); }, [expanded, loadBody]);
  useEffect(() => { if (targetLogicalMessageId) document.getElementById(`logical-message-${targetLogicalMessageId}`)?.scrollIntoView({ block: 'center' }); }, [targetLogicalMessageId, data]);
  const toggle = useCallback(id => setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }), []);
  if (!data && !error) return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>;
  return <section aria-label={t('conversation.label')} data-conversation-id={conversationId} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '24px 28px', minWidth: 0 }}>
    {messages.map(message => <ConversationMessage key={message.id} message={message} expanded={expanded.has(message.id)} onToggle={toggle} body={bodies[message.id]} status={bodyStatus[message.id]} onLoadBody={loadBody} onRemoteImages={id => loadBody(id, true, true)} onReply={onReply} />)}
  </section>;
}
