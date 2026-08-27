import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';
import { api } from '../utils/api.js';
import ConversationMessage from './ConversationMessage.jsx';
import { initialConversationExpansion, initialConversationTarget, toggleConversationExpansion } from './conversationExpansion.js';
import { alignReaderHeader } from './readerScrollAlignment.js';
import { nativeThreadToReaderMessages, mergeThreadWithConversation } from '../utils/conversationThreadAdapter.js';
import { queueReadStateMutation, isLatestReadStateMutation } from '../utils/readStateMutation.js';
import { useStore } from '../store/index.js';

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
  const autoReadStarted = useRef(new Set());
  const completedNavigationRef = useRef(new Set());
  const navigationStateRef = useRef(new Map());
  const automaticScrollRef = useRef(false);
  const [activeTargetLogicalId, setActiveTargetLogicalId] = useState(null);
  const updateMessage = useStore(state => state.updateMessage);

  useEffect(() => {
    let active = true;
    bodiesRef.current = {}; statusRef.current = {}; autoReadStarted.current = new Set(); completedNavigationRef.current = new Set(); navigationStateRef.current = new Map();
    setActiveTargetLogicalId(null);
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
      const selectedPhysicalTarget = messages.find(message => (message.copies || [])
        .some(copy => String(copy.id) === String(selectedCopyId)))?.id;
      const requestedTargetId = messages.some(message => message.id === targetLogicalMessageId)
        ? targetLogicalMessageId : selectedPhysicalTarget;
      setExpanded(initialConversationExpansion(messages, requestedTargetId));
      setData(result);
    }).catch(reason => active && setError(reason.message || t('conversation.loadFailed')));
    const controllers = aborters.current;
    return () => { active = false; for (const controller of controllers.values()) controller.abort(); controllers.clear(); };
  }, [conversationId, targetLogicalMessageId, nativeThreadId, nativeFolder, selectedAccountId, selectedCopyId, t]);

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

  const setLocalReadState = useCallback((copyId, read) => {
    setData(previous => !previous ? previous : {
      ...previous,
      logicalMessages: previous.logicalMessages.map(message => {
        const copies = (message.copies || []).map(copy => String(copy.id) === String(copyId)
          ? { ...copy, is_read: read, isRead: read } : copy);
        const ownCopy = copies.find(copy => String(copy.id) === String(copyId));
        return ownCopy ? { ...message, copies, unread: !read } : message;
      }),
    });
    updateMessage(copyId, { is_read: read, isRead: read });
  }, [updateMessage]);

  // Every read write (automatic and explicit) shares this per-copy serialized lane.
  // That keeps a late automatic read from overwriting a newer explicit unread intent.
  const setCopyReadState = useCallback((copyId, read) => {
    if (!copyId) return Promise.resolve();
    const before = messages.some(message => (message.copies || []).some(copy => String(copy.id) === String(copyId) && Boolean(copy.isRead ?? copy.is_read)));
    setLocalReadState(copyId, read);
    const mutation = queueReadStateMutation(copyId, read, targetRead => api.bulkRead([copyId], targetRead));
    return mutation.promise.catch(error => {
      if (isLatestReadStateMutation(copyId, mutation.version)) setLocalReadState(copyId, before);
      throw error;
    });
  }, [messages, setLocalReadState]);

  // CE resolves a logical target asynchronously, while native selection already
  // has the exact physical ID. Use that physical identity as the interim target so
  // a child click expands and scrolls its own native card without waiting for CE.
  const selectedPhysicalTarget = messages.find(message => (message.copies || [])
    .some(copy => String(copy.id) === String(selectedCopyId)))?.id;
  const requestedTargetId = messages.some(message => message.id === targetLogicalMessageId)
    ? targetLogicalMessageId : selectedPhysicalTarget;
  const initialTargetId = initialConversationTarget(messages, requestedTargetId);
  // Opening a conversation is a navigation to one physical target, never a reason to
  // bulk-mark the native thread. The set also prevents redundant reselect writes.
  useEffect(() => {
    const target = messages.find(message => message.id === initialTargetId);
    const copy = target && selectedCopyFor(target.id);
    if (!copy?.id || (copy.isRead ?? copy.is_read)) return;
    const key = String(copy.id);
    if (autoReadStarted.current.has(key)) return;
    autoReadStarted.current.add(key);
    setCopyReadState(copy.id, true).catch(() => {});
  }, [initialTargetId, messages, selectedCopyFor, setCopyReadState]);

  useEffect(() => {
    const sync = event => {
      const { id, read } = event.detail || {};
      if (id != null) setLocalReadState(id, read);
    };
    window.addEventListener('mailflow:read-state', sync);
    return () => window.removeEventListener('mailflow:read-state', sync);
  }, [setLocalReadState]);

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
  const navigationTargetId = activeTargetLogicalId || initialTargetId;
  // Align once when the target header mounts, then once more after that exact
  // body's iframe has applied its first measured height. The second pass uses the
  // final scroll range; later image/quote/resize changes deliberately do not resnap.
  const navigationKeyFor = useCallback(logicalId => {
    const copy = selectedCopyFor(logicalId);
    return `${conversationId || nativeThreadId || ''}:${copy?.id || logicalId}`;
  }, [conversationId, nativeThreadId, selectedCopyFor]);
  const alignNavigation = useCallback((navigationKey, reader, header, phase) => {
    const state = navigationStateRef.current.get(navigationKey);
    if (!state || state.userInteracted || (phase === 'final' && state.final)) return;
    automaticScrollRef.current = true;
    alignReaderHeader(reader, header);
    automaticScrollRef.current = false;
    if (phase === 'final') {
      state.final = true;
      completedNavigationRef.current.add(navigationKey);
    } else {
      state.preliminary = true;
      if (state.bodyReady) state.finalFrame = requestAnimationFrame(() => alignNavigation(navigationKey, reader, header, 'final'));
    }
  }, []);
  const handleInitialTargetBodyLayout = useCallback(copyId => {
    const logicalId = navigationTargetId;
    if (!logicalId || String(selectedCopyFor(logicalId)?.id || '') !== String(copyId || '')) return;
    const navigationKey = navigationKeyFor(logicalId);
    const state = navigationStateRef.current.get(navigationKey);
    if (!state || state.final || state.userInteracted) return;
    state.bodyReady = true;
    if (!state.preliminary || state.finalFrame) return;
    const reader = readerRef.current;
    const header = reader && [...reader.querySelectorAll('[data-conversation-message-header]')]
      .find(element => element.dataset.conversationMessageHeader === String(copyId));
    if (reader && header) state.finalFrame = requestAnimationFrame(() => {
      // The iframe's measured height becomes part of the reader range after its
      // parent card commits. One final frame samples that post-body geometry.
      state.finalFrame = requestAnimationFrame(() => alignNavigation(navigationKey, reader, header, 'final'));
    });
  }, [alignNavigation, navigationKeyFor, navigationTargetId, selectedCopyFor]);
  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || !navigationTargetId) return;
    const cancelFinal = () => {
      if (automaticScrollRef.current) return;
      const state = navigationStateRef.current.get(navigationKeyFor(navigationTargetId));
      if (!state || state.final) return;
      state.userInteracted = true;
      if (state.finalFrame) cancelAnimationFrame(state.finalFrame);
    };
    reader.addEventListener('wheel', cancelFinal, { passive: true });
    reader.addEventListener('touchstart', cancelFinal, { passive: true });
    reader.addEventListener('pointerdown', cancelFinal, { passive: true });
    return () => {
      reader.removeEventListener('wheel', cancelFinal);
      reader.removeEventListener('touchstart', cancelFinal);
      reader.removeEventListener('pointerdown', cancelFinal);
    };
  }, [navigationKeyFor, navigationTargetId]);
  useLayoutEffect(() => {
    if (!navigationTargetId || !readerRef.current || !expanded.has(navigationTargetId)) return;
    const navigationKey = navigationKeyFor(navigationTargetId);
    if (completedNavigationRef.current.has(navigationKey)) return;
    const reader = readerRef.current;
    const header = [...reader.querySelectorAll('[data-conversation-message-header]')]
      .find(element => element.dataset.conversationMessageHeader === String(selectedCopyFor(navigationTargetId)?.id || ''));
    if (!header) return;
    const state = navigationStateRef.current.get(navigationKey) || { preliminary: false, bodyReady: false, final: false, userInteracted: false, finalFrame: null };
    navigationStateRef.current.set(navigationKey, state);
    if (state.preliminary) return;
    const frame = requestAnimationFrame(() => alignNavigation(navigationKey, reader, header, 'preliminary'));
    return () => cancelAnimationFrame(frame);
  }, [alignNavigation, navigationKeyFor, navigationTargetId, expanded, messages, selectedCopyFor]);


  const activateMessage = useCallback(id => {
    setActiveTargetLogicalId(id);
    const copy = selectedCopyFor(id);
    if (copy?.id && !(copy.isRead ?? copy.is_read)) {
      const key = String(copy.id);
      if (!autoReadStarted.current.has(key)) {
        autoReadStarted.current.add(key);
        setCopyReadState(copy.id, true).catch(() => {});
      }
    }
  }, [selectedCopyFor, setCopyReadState]);
  const toggle = useCallback(id => {
    setExpanded(previous => {
      if (!previous.has(id)) activateMessage(id);
      return toggleConversationExpansion(previous, id);
    });
  }, [activateMessage]);
  if (!data && !error) return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)' }}>{t('conversation.loading')}</div>;
  if (error) return <div role="alert" style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>;
  return <section ref={readerRef} aria-label={t('conversation.label')} data-conversation-id={conversationId} data-reader-source={nativeThreadId ? 'native-thread' : 'conversation'} data-selected-copy-id={selectedCopyId || ''} data-selected-account-id={selectedAccountId || ''} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 0, minWidth: 0 }}>
    {messages.map(message => {
      const physicalCopyId = selectedCopyFor(message.id)?.id;
      return <ConversationMessage key={message.id} conversationId={conversationId} message={message} selectedCopyId={selectedCopyId} selectedAccountId={selectedAccountId} accounts={accounts} expanded={expanded.has(message.id)} onToggle={toggle} body={physicalCopyId ? bodiesByCopy[physicalCopyId] : null} status={physicalCopyId ? bodyStatusByCopy[physicalCopyId] : { unavailable: true }} onLoadBody={loadBody} onRemoteImages={id => loadBody(id, true, true)} onReply={onReply} onActionComplete={refresh} onSetRead={setCopyReadState} onInitialBodyLayout={handleInitialTargetBodyLayout} />;
    })}
  </section>;
}
