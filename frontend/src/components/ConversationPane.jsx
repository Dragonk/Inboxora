import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';

export default function ConversationPane({ conversationId, targetLogicalMessageId = null, onReply }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    conversationApi.detail(conversationId).then(data => {
      if (!cancelled) setState({ loading: false, error: null, data });
    }).catch(error => {
      if (!cancelled) setState({ loading: false, error: error.message || t('conversation.loadFailed'), data: null });
    });
    return () => { cancelled = true; };
  }, [conversationId, t]);

  if (state.loading) return <div role="status">{t('conversation.loading')}</div>;
  if (state.error) return <div role="alert">{state.error}</div>;
  const messages = state.data?.logicalMessages || [];
  return <section aria-label={t('conversation.label')} data-conversation-id={conversationId}>
    <header><h2>{state.data?.summary?.canonical_subject || t('conversation.noSubject')}</h2></header>
    {messages.map(message => {
      const open = expanded === message.id || targetLogicalMessageId === message.id;
      return <article key={message.id} id={`logical-message-${message.id}`} aria-expanded={open}>
        <button type="button" style={{ minHeight: 44, width: '100%', textAlign: 'left' }} onClick={() => setExpanded(open ? null : message.id)}>
          {message.subject || t('conversation.noSubject')} — {message.direction}
        </button>
        {open && <div role="region" aria-label={t('conversation.bodyLabel')}>
          {message.copies?.map(copy => <div key={copy.id} data-copy-id={copy.id}>
            {copy.bodyHtml ? <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(copy.bodyHtml, { ADD_ATTR: ['target'] }) }} /> : <p>{copy.bodyText || copy.snippet || ''}</p>}
          </div>)}
          <div className="conversation-actions">
            <button type="button" onClick={() => onReply?.(message.copies?.[0] || message)}>{t('conversation.reply')}</button>
            <button type="button" onClick={async () => {
              await conversationApi.applyOverride(conversationId, { overrideType: 'manual-split', logicalMessageId: message.id, reason: 'user-requested-split' });
              const data = await conversationApi.detail(conversationId);
              setState({ loading: false, error: null, data });
            }}>{t('conversation.split')}</button>
            <button type="button" onClick={async () => {
              await conversationApi.applyOverride(conversationId, { overrideType: 'lock-conversation', reason: 'user-requested-lock' });
            }}>{t('conversation.lock')}</button>
          </div>
        </div>}
      </article>;
    })}
  </section>;
}
