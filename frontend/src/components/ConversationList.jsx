import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { conversationApi } from '../utils/conversationApi.js';

function OwnReplyMarker({ visible }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return <span role="img" aria-label={t('conversation.latestOwnReply')} title={t('conversation.latestOwnReply')}>↩</span>;
}

export default function ConversationList({ params = {}, onOpenMessage }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    conversationApi.list(params).then(data => {
      if (!cancelled) {
        setRows(data.conversations || []);
        setNextCursor(data.nextCursor || null);
      }
    }).catch(err => {
      if (!cancelled) setError(err.message || t('conversation.loadFailed'));
    });
    return () => { cancelled = true; };
  }, [paramsKey, t]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div role="alert">{error}</div>;
  return <div role="list" aria-label={t('conversation.listLabel')}>
    {rows.map(row => {
      const open = expanded === row.conversation_id;
      return <div key={row.conversation_id} role="listitem">
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
          <button type="button" data-testid={`conversation-expand-${row.conversation_id}`} aria-label={`${open ? t('conversation.collapse') : t('conversation.expand')} ${t('conversation.label')}`} aria-expanded={open}
            onClick={() => setExpanded(open ? null : row.conversation_id)}>{open ? '▾' : '▸'}</button>
          <button type="button" style={{ flex: 1, textAlign: 'left', minHeight: 44 }} onClick={() => onOpenMessage?.(row)}>
            <span>{row.canonical_subject || t('conversation.noSubject')}</span>{' '}
            <span aria-label={t('conversation.messageCount', { count: row.logical_message_count || row.visible_copy_count || 1 })}>({row.logical_message_count || row.visible_copy_count || 1})</span>{' '}
            <OwnReplyMarker visible={row.latest_message_is_mine} />
          </button>
        </div>
        {open && <div role="group" aria-label={t('conversation.messagesLabel')}>
          {(row.logical_messages || []).map(message => <button key={message.id} type="button" data-logical-message-id={message.id} style={{ minHeight: 44, width: '100%', textAlign: 'left', fontWeight: message.unread ? 700 : 400 }} onClick={() => onOpenMessage?.({ ...row, logical_message_id: message.id })}>
            <span>{message.direction === 'outgoing' || message.direction === 'self' ? t('message.you') : (message.fromName || message.fromEmail || t('conversation.unknownSender'))}</span>{' '}
            <span>{message.snippet || message.subject || t('conversation.noSubject')}</span>{' '}
            {message.hasAttachments && <span aria-label={t('message.hasAttachments')}>📎</span>}
            {message.isLatest && row.latest_message_is_mine && <OwnReplyMarker visible />}
          </button>)}
        </div>}
      </div>;
    })}
    {nextCursor && <button type="button" onClick={async () => {
      setLoadingMore(true);
      try {
        const data = await conversationApi.list({ ...params, cursor: nextCursor });
        setRows(previous => [...previous, ...(data.conversations || [])]);
        setNextCursor(data.nextCursor || null);
      } catch (err) {
        setError(err.message || t('conversation.loadFailed'));
      } finally {
        setLoadingMore(false);
      }
    }} disabled={loadingMore}>{loadingMore ? t('conversation.loading') : t('conversation.loadMore')}</button>}
  </div>;
}
