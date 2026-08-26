import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import { api } from '../utils/api.js';
import ConversationMessage from './ConversationMessage.jsx';
import { initialConversationExpansion, initialConversationTarget, toggleConversationExpansion } from './conversationExpansion.js';
import { nativeThreadToReaderMessages, mergeThreadWithConversation } from '../utils/conversationThreadAdapter.js';

// Data-only CE adapter. It owns logical/physical identity and expansion policy;
// MessagePane owns the pane geometry and ConversationMessage uses MessagePane visuals.
//
// P1-B: When nativeThreadId is available, the reader loads the complete account-local
// native thread (/mail/thread/:threadId) as the PRIMARY source of thread membership.
// CE detail enriches this data (logical identity, manual overrides) but incomplete CE
// state MUST NOT silently reduce 3 native thread messages to 1 reader card. Each unique
// real message gets one reader card; CE metadata is attached when it exists.
export default function ConversationReader({ conversationId, targetLogicalMessageId = null, selectedCopyId = null, selectedAccountId = null, accounts = [], onReply, nativeThreadId = null, nativeFolder = null }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  // Body/cache/request identity is the physical copy ID. A logical message can
  // resolve to a different copy when the selected account/target changes.
  const [bodiesByCopy, setBodiesByCopy] = useState({});
  const [bodyStatusByCopy, setBodyStatusByCopy] = useState({});
  const bodiesRef = useRef({});
  const statusRef = useRef({});
  const aborters = useRef(new Map());
  const readerRef = useRef(null);

  useEffect(() => {
    let active = true;
    bodiesRef.current = {}; statusRef.current = {};
    setData(null); setError(null); setBodiesByCopy({}); setBodyStatusByCopy({}); setExpanded(new Set());
    // P1-B: Load the native thread (primary) and CE detail (enrichment) in parallel.
    // Native thread membership is the proven UI threading source; CE metadata enriches
    // but incomplete CE state must not reduce the reader below the native thread size.
    const cePromise = conversationId
      ? conversationApi.detail(conversationId).catch(() => null)
      : Promise.resolve(null);
    const nativePromise = nativeThreadId && selectedAccountId
      ? api.getThread(nativeThreadId, nativeFolder || 'INBOX', false, selectedAccountId)
          .then(result => result?.messages || [])
          .catch(() => [])
      : Promise.resolve([]);
    Promise.all([cePromise, nativePromise]).then(([ceResult, nativeMessages]) => {
      if (!active) return;
      const ceLogicalMessages = ceResult?.logicalMessages || [];
      const nativeReaderMessages = nativeThreadToReaderMessages(nativeMessages, selectedAccountId);
      // Native children are primary; CE enriches. If native is empty (no thread_key or
      // flat single message), fall back to CE-only so the reader still works.
      const messages = nativeReaderMessages.length
        ? mergeThreadWithConversation(ceLogicalMessages, nativeReaderMessages)
        : ceLogicalMessages;
      const result = { ...ceResult, logicalMessages: messages };
      setExpanded(initialConversationExpansion(messages, targetLogicalMessageId));
      setData(result);
    }).catch(reason => active && setError(reason.message || t('conversation.loadFailed')));
    const controllers = aborters.current;
    return () => { active = false; for (const controller of controllers.values()) controller.abort(); controllers.clear(); };
  }, [conversationId, targetLogicalMessageId, nativeThreadId, nativeFolder, selectedAccountId, t]);

  const messages = useMemo(() => data?.logicalMessages || [], [data]);
  const refresh = useCallback(() => conversationApi.detail(conversationId).then(setData), [conversationId]);
  useEffect(() => {
    const handleConversationRefresh = event => {
      if (event.detail?.conversationId === conversationId) refresh().catch(() => {});
    };
    window.addEventListener('mailflow:conversation-refresh', handleConversationRefresh);
    return () => window.removeEventListener('mailflow:conversation-refresh', handleConversationRefresh);
  }, [conversationId, refresh]);
  const selectedCopyFor = useCallback(logicalId => {
    const logical = messages.find(item => item.id === logicalId);
    const sameAccountCopies = (logical?.copies || []).filter(copy => String(copy.accountId ?? copy.account_id) === String(selectedAccountId));
    return sameAccountCopies.find(item => String(item.id) === String(selectedCopyId))
      || [...sameAccountCopies].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]
      || null;
  }, [messages, selectedAccountId, selectedCopyId]);

  const loadBody = useCallback((logicalId, force = false, remoteImages = false) => {
    const copy = selectedCopyFor(logicalId);
    const physicalCopyId = copy?.id;
    if (!physicalCopyId) return Promise.resolve();
    const currentStatus = statusRef.current[physicalCopyId];
    if (!force && (bodiesRef.current[physicalCopyId] || currentStatus?.loading || currentStatus?.error)) return Promise.resolve();
    aborters.current.get(physicalCopyId)?.abort();
    const controller = new AbortController();
    aborters.current.set(physicalCopyId, controller);
    statusRef.current = { ...statusRef.current, [physicalCopyId]: { loading: true } };
    setBodyStatusByCopy(statusRef.current);
    return api.getMessageBody(physicalCopyId, remoteImages)
      .then(body => {
        if (controller.signal.aborted) return;
        const normalized = { ...body, remoteImages: Boolean(remoteImages || body.remoteImages || body.remote_images) };
        const hasContent = Boolean(normalized.html ?? normalized.body_html ?? normalized.text ?? normalized.body_text)
          || (Array.isArray(normalized.attachments) && normalized.attachments.length > 0);
        bodiesRef.current = hasContent ? { ...bodiesRef.current, [physicalCopyId]: normalized } : bodiesRef.current;
        statusRef.current = { ...statusRef.current, [physicalCopyId]: hasContent ? { loading: false } : { loading: false, unavailable: true } };
        setBodiesByCopy(bodiesRef.current);
        setBodyStatusByCopy(statusRef.current);
      })
      .catch(reason => {
        if (reason.name === 'AbortError' || controller.signal.aborted) return;
        statusRef.current = { ...statusRef.current, [physicalCopyId]: { loading: false, error: reason.message || t('conversation.loadBodyFailed') } };
        setBodyStatusByCopy(statusRef.current);
      })
      .finally(() => {
        if (aborters.current.get(physicalCopyId) === controller) aborters.current.delete(physicalCopyId);
      });
  }, [selectedCopyFor, t]);
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
    {messages.map(message => {
      const physicalCopyId = selectedCopyFor(message.id)?.id;
      return <ConversationMessage key={message.id} conversationId={conversationId} message={message} selectedCopyId={selectedCopyId} selectedAccountId={selectedAccountId} accounts={accounts} expanded={expanded.has(message.id)} onToggle={toggle} body={physicalCopyId ? bodiesByCopy[physicalCopyId] : null} status={physicalCopyId ? bodyStatusByCopy[physicalCopyId] : { unavailable: true }} onLoadBody={loadBody} onRemoteImages={id => loadBody(id, true, true)} onReply={onReply} onActionComplete={refresh} />;
    })}
  </section>;
}
