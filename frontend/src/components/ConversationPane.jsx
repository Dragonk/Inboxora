import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import MessageBodyRenderer from './MessageBodyRenderer.jsx';

function newestCopy(message) {
  return [...(message.copies || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(Boolean(a.isRead)) - Number(Boolean(b.isRead)))[0] || null;
}

export default function ConversationPane({ conversationId, targetLogicalMessageId = null, onReply }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(new Set());
  const [bodies, setBodies] = useState({});
  const [bodyStatus, setBodyStatus] = useState({});
  const inFlight = useRef(new Map());
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    conversationApi.detail(conversationId).then(data => {
      if (cancelled) return;
      const messages = data.logicalMessages || [];
      const newest = messages.at(-1)?.id;
      const unread = messages.filter(message => message.copies?.some(copy => !copy.isRead)).map(message => message.id);
      const initialIds = new Set([newest, ...unread, targetLogicalMessageId].filter(Boolean));
      setExpanded(initialIds);
      setState({ loading: false, error: null, data });
      for (const message of messages) if (initialIds.has(message.id)) loadBody(message.id).catch(() => {});
    }).catch(error => { if (!cancelled) setState({ loading: false, error: error.message || t('conversation.loadFailed'), data: null }); });
    return () => { cancelled = true; };
  }, [conversationId, targetLogicalMessageId, t]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { for (const controller of inFlight.current.values()) controller.abort(); inFlight.current.clear(); }, [conversationId]);

  const loadBody = async (logicalId, force = false) => {
    if (!force && (bodies[logicalId] || inFlight.current.has(logicalId))) return;
    const controller = new AbortController();
    inFlight.current.set(logicalId, controller);
    setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: true, error: null } }));
    try {
      const body = await conversationApi.body(conversationId, logicalId, controller.signal);
      setBodies(previous => ({ ...previous, [logicalId]: body }));
      setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, error: null } }));
    } catch (error) {
      if (error.name !== 'AbortError') setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, error: error.message || t('conversation.loadFailed') } }));
    } finally { inFlight.current.delete(logicalId); }
  };
  if (state.loading) return <div role="status">{t('conversation.loading')}</div>;
  if (state.error) return <div role="alert">{state.error}</div>;
  const messages = state.data?.logicalMessages || [];
  return <section aria-label={t('conversation.label')} data-conversation-id={conversationId}>
    <header><h2>{state.data?.summary?.canonical_subject || t('conversation.noSubject')}</h2></header>
    {messages.map(message => {
      const open = expanded.has(message.id);
      const copy = newestCopy(message);
      const body = bodies[message.id];
      const bodyId = `logical-message-body-${message.id}`;
      return <article key={message.id} id={`logical-message-${message.id}`} data-logical-message-id={message.id}>
        <button type="button" aria-expanded={open} aria-controls={bodyId} style={{ minHeight: 44, width: '100%', textAlign: 'left' }} onClick={() => {
          setExpanded(previous => { const next = new Set(previous); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next; });
          if (!body) loadBody(message.id).catch(() => {});
        }}>
          <strong>{copy?.fromName || copy?.fromEmail || (message.direction === 'outgoing' || message.direction === 'self' ? t('message.you') : t('conversation.unknownSender'))}</strong>{' '}
          <span>{message.subject || t('conversation.noSubject')}</span>{' '}
          <time>{message.messageDate ? new Date(message.messageDate).toLocaleString() : ''}</time>
        </button>
        {open && <div id={bodyId} role="region" aria-label={t('conversation.bodyLabel')}>
          <p>{copy?.snippet || ''}</p>
          {bodyStatus[message.id]?.loading && <div role="status">{t('conversation.loading')}</div>}
          {bodyStatus[message.id]?.error && <div role="alert">{bodyStatus[message.id].error} <button type="button" onClick={() => loadBody(message.id, true)}>{t('common.retry')}</button></div>}
          {body && <MessageBodyRenderer html={body.body_html} text={body.body_text} />}
          <div className="conversation-actions">
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id })}>{t('conversation.reply')}</button>
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, replyAll: true })}>{t('conversation.replyAll')}</button>
            <button type="button" onClick={() => onReply?.({ ...copy, copies: message.copies, logicalMessageId: message.id, forward: true })}>{t('conversation.forward')}</button>
          </div>
        </div>}
      </article>;
    })}
  </section>;
}
