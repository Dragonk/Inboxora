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
  const [error, setError] = useState(null);

  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    let cancelled = false;
    conversationApi.list(params).then(data => { if (!cancelled) setRows(data.conversations || []); }).catch(err => {
      if (!cancelled) setError(err.message || t('conversation.loadFailed'));
    });
    return () => { cancelled = true; };
  }, [paramsKey, t, params]);

  if (error) return <div role="alert">{error}</div>;
  return <div role="list" aria-label={t('conversation.listLabel')}>
    {rows.map(row => {
      const open = expanded === row.conversation_id;
      return <div key={row.conversation_id} role="listitem">
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 44 }}>
          <button type="button" aria-label={`${open ? t('conversation.collapse') : t('conversation.expand')} ${t('conversation.label')}`} aria-expanded={open}
            onClick={() => setExpanded(open ? null : row.conversation_id)}>{open ? '▾' : '▸'}</button>
          <button type="button" style={{ flex: 1, textAlign: 'left', minHeight: 44 }} onClick={() => onOpenMessage?.(row)}>
            <span>{row.canonical_subject || t('conversation.noSubject')}</span>{' '}
            <span aria-label={t('conversation.messageCount', { count: row.logical_message_count || row.visible_copy_count || 1 })}>({row.logical_message_count || row.visible_copy_count || 1})</span>{' '}
            <OwnReplyMarker visible={row.latest_message_is_mine} />
          </button>
        </div>
        {open && <div role="group" aria-label={t('conversation.messagesLabel')}>
          <button type="button" style={{ minHeight: 44, width: '100%', textAlign: 'left' }} onClick={() => onOpenMessage?.(row)}>
            {row.canonical_subject || t('conversation.noSubject')}
          </button>
        </div>}
      </div>;
    })}
  </div>;
}
