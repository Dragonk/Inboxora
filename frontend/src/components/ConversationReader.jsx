import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import { api } from '../utils/api.js';
import ConversationMessage from './ConversationMessage.jsx';
import { initialConversationExpansion, initialConversationTarget, toggleConversationExpansion } from './conversationExpansion.js';

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
      // Only the resolver-selected message starts open. If that identity is stale,
      // fall back to the newest logical message while preserving independent toggles.
      setExpanded(initialConversationExpansion(messages, targetLogicalMessageId));
      setData(result);
    }).catch(reason => active && setError(reason.message || t('conversation.loadFailed')));
    const controllers = aborters.current;
    return () => { active = false; for (const controller of controllers.values()) controller.abort(); controllers.clear(); };
  }, [conversationId, targetLogicalMessageId, t]);

  const messages = useMemo(() => data?.logicalMessages || [], [data]);
  const refresh = useCallback(() => conversationApi.detail(conversationId).then(setData), [conversationId]);
  useEffect(() => {
    const handleConversationRefresh = event => {
      if (event.detail?.conversationId === conversationId) refresh().catch(() => {});
    };
    window.addEventListener('mailflow:conversation-refresh', handleConversationRefresh);
    return () => window.removeEventListener('mailflow:conversation-refresh', handleConversationRefresh);
  }, [conversationId, refresh]);
  const loadBody = useCallback((logicalId, force = false, remoteImages = false) => {
    const currentStatus = bodyStatus[logicalId];
    if (!force && (bodies[logicalId] || currentStatus?.loading || currentStatus?.error || currentStatus?.unavailable)) return Promise.resolve();
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
    return api.getMessageBody(copy.id, remoteImages)
      .then(body => { if (!controller.signal.aborted) { setBodies(previous => ({ ...previous, [logicalId]: body })); setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false } })); } })
      .catch(reason => { if (reason.name !== 'AbortError') setBodyStatus(previous => ({ ...previous, [logicalId]: { loading: false, error: reason.message || t('conversation.loadBodyFailed') } })); });
  }, [bodies, bodyStatus, messages, selectedAccountId, selectedCopyId, t]);
  useEffect(() => { for (const id of expanded) loadBody(id); }, [expanded, loadBody]);
  useEffect(() => {
    const targetId = initialConversationTarget(messages, targetLogicalMessageId);
    if (!targetId) return;
    const target = [...readerRef.current?.querySelectorAll('[data-logical-message-id]') || []]
      .find(element => element.dataset.logicalMessageId === targetId);
    target?.scrollIntoView({ block: 'start' });
  }, [targetLogicalMessageId, messages]);
  const toggle = useCallback(id => setExpanded(previous => toggleConversationExpansion(previous, id)), []);
  if (!data && !error) return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>;
  return <section ref={readerRef} aria-label={t('conversation.label')} data-conversation-id={conversationId} data-selected-copy-id={selectedCopyId || ''} data-selected-account-id={selectedAccountId || ''} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 0, minWidth: 0 }}>
    {messages.map(message => <ConversationMessage key={message.id} conversationId={conversationId} message={message} selectedCopyId={selectedCopyId} selectedAccountId={selectedAccountId} accounts={accounts} expanded={expanded.has(message.id)} onToggle={toggle} body={bodies[message.id]} status={bodyStatus[message.id]} onLoadBody={loadBody} onRemoteImages={id => loadBody(id, true, true)} onReply={onReply} onActionComplete={refresh} />)}
  </section>;
}
