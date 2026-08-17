import { useEffect, useState } from 'react';
import { conversationApi } from '../utils/conversationApi.js';

function OwnReplyMarker({ visible }) {
  if (!visible) return null;
  return <span role="img" aria-label="Latest own reply" title="Latest own reply">↩</span>;
}

export default function ConversationList({ params = {}, onOpenMessage }) {
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    conversationApi.list(params).then(data => {
      if (cancelled) return;
      if (!data || !Array.isArray(data.conversations)) throw new Error('Invalid conversation response');
      setRows(data.conversations);
    }).catch(err => { if (!cancelled) setError(err.message || 'Failed to load conversations'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [JSON.stringify(params)]);

  if (loading) return <div role="status" aria-live="polite">Loading conversations…</div>;
  if (error) return <div role="alert">{error}</div>;
  if (!rows.length) return <div role="status">No conversations</div>;
  return <div role="list" aria-label="Conversations">
    {rows.map(row => {
      const open = expanded === row.conversation_id;
      const detailsId = `conversation-${row.conversation_id}`;
      return <div key={row.conversation_id} role="listitem">
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
          <button type="button" aria-label={`${open ? 'Collapse' : 'Expand'} conversation`} aria-expanded={open} aria-controls={detailsId}
            onClick={() => setExpanded(open ? null : row.conversation_id)}>{open ? '▾' : '▸'}</button>
          <button type="button" style={{ flex: 1, textAlign: 'left', minHeight: 44 }} onClick={() => onOpenMessage?.(row)}>
            <span>{row.canonical_subject || '(no subject)'}</span>{' '}
            <span aria-label={`${row.logical_message_count || row.visible_copy_count || 1} messages`}>({row.logical_message_count || row.visible_copy_count || 1})</span>{' '}
            <OwnReplyMarker visible={row.latest_message_is_mine} />
          </button>
        </div>
        {open && <div id={detailsId} role="group" aria-label="Conversation messages">
          <button type="button" style={{ minHeight: 44, width: '100%', textAlign: 'left' }} onClick={() => onOpenMessage?.(row)}>
            {row.canonical_subject || '(no subject)'}
          </button>
        </div>}
      </div>;
    })}
  </div>;
}
