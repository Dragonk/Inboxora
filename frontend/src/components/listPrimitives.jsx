/**
 * Shared list-row primitives used by both MessageList (flat/threaded rows)
 * and GroupedConversationList (conversation parent/child rows).
 *
 * These are intentionally small, stateless, presentational components so they
 * can be reused without pulling in the heavy row logic (swipe, selection,
 * hover, keyboard) that differs between flat and grouped modes.
 */
import { useTranslation } from 'react-i18next';
import { formatDate } from '../utils/formatDate.js';

// ── Date ───────────────────────────────────────────────────────────────
// Re-export so both list surfaces import the SAME date formatter. Never
// keep a local formatListDate copy — it will drift.
export { formatDate as formatListDate };

// ── Unread badge ───────────────────────────────────────────────────────
export function UnreadBadge({ count }) {
  const { t } = useTranslation();
  if (!count || count <= 0) return null;
  return (
    <span
      aria-label={t('conversation.unreadCount', { count })}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
        background: 'var(--accent)', color: 'white',
        fontSize: 11, fontWeight: 700, lineHeight: 1,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

// ── Attachment icon ───────────────────────────────────────────────────
export function AttachmentIcon({ visible }) {
  if (!visible) return null;
  return (
    <span aria-label="📎" style={{ fontSize: 12, flexShrink: 0 }}>📎</span>
  );
}

// ── Star indicator ────────────────────────────────────────────────────
export function StarIndicator({ starred }) {
  const { t } = useTranslation();
  if (!starred) return null;
  return (
    <span
      aria-label={t('conversation.star')}
      title={t('conversation.star')}
      style={{ color: 'var(--amber, #f59e0b)', fontSize: 12, flexShrink: 0 }}
    >★</span>
  );
}

// ── Own-reply marker (CE-specific: shows when the latest message is from the user) ──
export function OwnReplyMarker({ visible }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <span
      role="img"
      aria-label={t('conversation.latestOwnReply')}
      title={t('conversation.latestOwnReply')}
      style={{ fontSize: 12, flexShrink: 0 }}
    >↩</span>
  );
}

// ── Account badge (CE-specific: shows which accounts have copies of this conversation) ──
export function AccountBadge({ accounts = [] }) {
  if (!accounts.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
      {accounts.slice(0, 3).map((a, i) => (
        <span
          key={i}
          title={a.email || a.label || ''}
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: a.color || 'var(--accent)',
            flexShrink: 0,
          }}
        />
      ))}
      {accounts.length > 3 && (
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>+{accounts.length - 3}</span>
      )}
    </span>
  );
}

// ── Logical count badge (CE-specific: number of logical messages in the conversation) ──
export function LogicalCountBadge({ count }) {
  if (!count || count <= 1) return null;
  return (
    <span
      style={{
        fontSize: 10, color: 'var(--text-tertiary)',
        flexShrink: 0, fontWeight: 500,
      }}
    >{`(${count})`}</span>
  );
}
