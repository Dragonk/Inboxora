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
