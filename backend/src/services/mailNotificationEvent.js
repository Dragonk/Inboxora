// Canonical "Inboxora received a new message" notification event.
//
// Every notification channel (browser Web Push, native Android push) is derived
// from THIS one object, built once at the point where IMAP IDLE / mail sync has
// already persisted the new message. Nothing else detects new mail, so the
// dispatcher never races a second detector.
//
// The event carries two payload shapes:
//   - webPush: the rich payload the existing PWA service worker renders;
//   - native:  the privacy-preserving opaque wake-up sent through an external
//              push provider ({ type: 'mail.changed', eventId }). No sender,
//              subject, address or body ever leaves the self-hosted server.
export const MAIL_CHANGED_TYPE = 'mail.changed';

export function buildMailNotificationEvent({
  userId,
  message,
  alertCount = 1,
  unreadCount,
  icon = '/inboxora-envelope-512.png',
} = {}) {
  const eventId = typeof message?.id === 'string' && message.id ? message.id : null;
  const count = Number.isFinite(alertCount) && alertCount > 0 ? alertCount : 1;
  const title = message?.fromName || message?.fromEmail || 'New mail';
  const body = count === 1 ? (message?.subject || '(no subject)') : `${count} new messages`;

  const webPush = { title, body, icon, url: eventId ? `/?m=${eventId}` : '/' };
  if (unreadCount != null) webPush.unreadCount = unreadCount;

  return {
    userId,
    eventId,
    alertCount: count,
    accountId: message?.account_id ?? message?.accountId ?? null,
    folder: message?.folder ?? 'INBOX',
    webPush,
    native: eventId ? { type: MAIL_CHANGED_TYPE, eventId } : null,
  };
}
