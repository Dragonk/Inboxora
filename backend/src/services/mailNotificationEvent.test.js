import { describe, expect, it } from 'vitest';
import { buildMailNotificationEvent, MAIL_CHANGED_TYPE } from './mailNotificationEvent.js';

describe('buildMailNotificationEvent', () => {
  it('derives both payload shapes from one persisted message', () => {
    const event = buildMailNotificationEvent({
      userId: 'user-1',
      message: { id: 'msg-1', account_id: 'acct-1', folder: 'INBOX', fromName: 'Ada', subject: 'Hello', fromEmail: 'ada@example.com' },
      alertCount: 1,
      unreadCount: 3,
    });

    expect(event.userId).toBe('user-1');
    expect(event.eventId).toBe('msg-1');
    expect(event.webPush).toEqual({
      title: 'Ada', body: 'Hello', icon: '/inboxora-envelope-512.png', url: '/?m=msg-1', unreadCount: 3,
    });
    expect(event.native).toEqual({ type: MAIL_CHANGED_TYPE, eventId: 'msg-1' });
  });

  it('never puts message content in the native provider payload', () => {
    const event = buildMailNotificationEvent({
      userId: 'user-1',
      message: { id: 'msg-1', fromName: 'Ada', fromEmail: 'ada@example.com', subject: 'Secret subject' },
      alertCount: 1,
    });

    const serialized = JSON.stringify(event.native);
    expect(Object.keys(event.native).sort()).toEqual(['eventId', 'type']);
    expect(serialized).not.toContain('Ada');
    expect(serialized).not.toContain('ada@example.com');
    expect(serialized).not.toContain('Secret subject');
  });

  it('summarises a batch and falls back to a generic sender', () => {
    const event = buildMailNotificationEvent({
      userId: 'user-1',
      message: { id: 'msg-2', fromEmail: '', subject: '' },
      alertCount: 4,
    });
    expect(event.webPush.title).toBe('New mail');
    expect(event.webPush.body).toBe('4 new messages');
  });

  it('produces no native event when the message has no stable id to dedup on', () => {
    const event = buildMailNotificationEvent({ userId: 'user-1', message: { subject: 'x' }, alertCount: 1 });
    expect(event.eventId).toBeNull();
    expect(event.native).toBeNull();
    expect(event.webPush.url).toBe('/');
  });
});
