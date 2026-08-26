import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import ConversationMessage from './ConversationMessage.jsx';

// Data-only CE adapter. It owns logical/physical identity and expansion policy;
// MessagePane owns the pane geometry and ConversationMessage uses MessagePane visuals.
export default function ConversationReader({ conversationId, targetLogicalMessageId = null, selectedCopyId = null, selectedAccountId = null, accounts = [], onReply }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [bodies, setBodies] = useState({});
  const [bodyStatus, setBodyStatus] = useState({});
  const aborters = useRef(new Map());
  const readerRef = useRef(null);

  useEffect(() => {
    let active = true;
    setData(null); setError(null); setBodies({}); setBodyStatus({}); setExpanded(new Set());
    conversationApi.detail(conversationId).then(result => {
      if (!active) return;
      const messages = result.logicalMessages || [];
      const newest = messages.at(-1)?.id;
      // Expand the selected/latest message initially. Each message keeps independent
      // expand/collapse state afterwards, so multiple messages may stay open.
      const selected = messages.some(message => message.id === targetLogicalMessageId)
        ? targetLogicalMessageId
        : newest;
      setExpanded(new Set([selected].filter(Boolean)));
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
    const sameAccountCopies = (logical?.copies || []).filter(copy => copy.accountId === selectedAccountId);
    const copy = sameAccountCopies.find(item => item.id === selectedCopyId)
      || [...sameAccountCopies].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    if (!copy) {
      setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, unavailable: true } }));
      return Promise.resolve();
    }
    setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: true } }));
    return conversationApi.body(conversationId, logicalId, controller.signal, copy?.id, remoteImages)
      .then(body => { if (!controller.signal.aborted) { setBodies(previous => ({ ...previous, [logicalId]: body })); setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false } })); } })
      .catch(reason => { if (reason.name !== 'AbortError') setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, error: reason.message || t('conversation.loadBodyFailed') } })); });
  }, [bodies, bodyStatus, conversationId, messages, selectedAccountId, selectedCopyId, t]);
  useEffect(() => { for (const id of expanded) loadBody(id); }, [expanded, loadBody]);
  useEffect(() => {
    if (!targetLogicalMessageId || !messages.some(message => message.id === targetLogicalMessageId)) return;
    const target = [...readerRef.current?.querySelectorAll('[data-logical-message-id]') || []]
      .find(element => element.dataset.logicalMessageId === targetLogicalMessageId);
    target?.scrollIntoView({ block: 'center' });
  }, [targetLogicalMessageId, messages]);
  const toggle = useCallback(id => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  if (!data && !error) return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>;
  return <section ref={readerRef} aria-label={t('conversation.label')} data-conversation-id={conversationId} data-selected-copy-id={selectedCopyId || ''} data-selected-account-id={selectedAccountId || ''} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 0, minWidth: 0 }}>
    {messages.map(message => <ConversationMessage key={message.id} message={message} selectedCopyId={selectedCopyId} selectedAccountId={selectedAccountId} accounts={accounts} expanded={expanded.has(message.id)} onToggle={toggle} body={bodies[message.id]} status={bodyStatus[message.id]} onLoadBody={loadBody} onRemoteImages={id => loadBody(id, true, true)} onReply={onReply} />)}
  </section>;
}
