import { useTranslation } from 'react-i18next';
import { senderColor } from '../themes.js';
import SenderAvatarImage from './SenderAvatarImage.jsx';

export function messageDirection(direction) {
  return direction === 'outgoing' || direction === 'self' ? 'outgoing' : 'incoming';
}

export function MessageDirection({ direction, label }) {
  const normalized = messageDirection(direction);
  return <span
    data-message-direction={normalized}
    aria-label={label}
    style={{ color: normalized === 'outgoing' ? 'var(--accent)' : 'var(--blue, #3b82f6)', fontWeight: 700, flexShrink: 0 }}
  >{normalized === 'outgoing' ? '→' : '←'}</span>;
}

export function MessageAvatar({ email, name, size = 40, hasContactPhoto }) {
  const value = name || email || '?';
  return <span style={{
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    background: senderColor(email || name), color: 'white', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: Math.max(12, size * .4),
    fontWeight: 700, overflow: 'hidden', position: 'relative',
  }}>
    {value[0]?.toUpperCase()}<SenderAvatarImage email={email} hasContactPhoto={hasContactPhoto} />
  </span>;
}

export function MessageActionBar({ onReply, onReplyAll, onForward, targetId }) {
  const { t } = useTranslation();
  const actions = [
    [t('message.reply'), onReply, 'reply'],
    [t('message.replyAll'), onReplyAll, 'reply-all'],
    [t('message.forward'), onForward, 'forward'],
  ];
  return <div data-conversation-message-actions="true" data-action-target-id={targetId} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 0' }}>
    {actions.map(([label, handler, action]) => <button key={action} type="button" data-message-action={action} data-action-target-id={targetId} onClick={handler} style={actionStyle}>{label}</button>)}
  </div>;
}

export const actionStyle = {
  border: 0, borderRadius: 6, padding: '6px 9px', background: 'transparent',
  color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, fontWeight: 500,
};
