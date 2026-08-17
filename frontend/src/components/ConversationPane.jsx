import { useEffect, useState } from 'react';
import { conversationApi } from '../utils/conversationApi.js';

export default function ConversationPane({ conversationId, targetLogicalMessageId = null, onReply }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [expanded, setExpanded] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    conversationApi.detail(conversationId).then(data => {
      if (!cancelled) setState({ loading: false, error: null, data });
    }).catch(error => {
      if (!cancelled) setState({ loading: false, error: error.message || 'Failed to load conversation', data: null });
    });
    return () => { cancelled = true; };
  }, [conversationId]);

  if (state.loading) return <div role="status">Loading conversation…</div>;
  if (state.error) return <div role="alert">{state.error}</div>;
  const messages = state.data?.logicalMessages || [];
  return <section aria-label="Conversation" data-conversation-id={conversationId}>
    <header><h2>{state.data?.summary?.canonical_subject || '(no subject)'}</h2></header>
    {messages.map(message => {
      const open = expanded === message.id || targetLogicalMessageId === message.id;
      return <article key={message.id} id={`logical-message-${message.id}`} aria-expanded={open}>
        <button type="button" style={{ minHeight: 44, width: '100%', textAlign: 'left' }} onClick={() => setExpanded(open ? null : message.id)}>
          {message.subject || '(no subject)'} — {message.direction}
        </button>
        {open && <div role="region" aria-label="Message body">
          <button type="button" onClick={() => onReply?.(message)}>Reply</button>
        </div>}
      </article>;
    })}
  </section>;
}
