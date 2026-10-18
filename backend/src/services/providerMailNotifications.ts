// New-mail notification emission for the native-transport sync paths.
//
// The canonical new-mail event (buildMailNotificationEvent) was previously
// built only by the IMAP sync, so Microsoft Graph and Gmail API accounts never
// notified: no Web Push for the PWA, no badge, no native push — while every
// notification channel derives from that one event. Both provider syncs now call
// the same helper with the rows their incremental delta just created, and the
// event fans out to every channel exactly as the IMAP event does.
//
// Constraints mirrored from the IMAP emission (imapManager):
//   - INBOX only, and only rows that are still unread — the ingest rules have
//     already run, so mail silenced by a mark_read rule is filtered here;
//   - one event per delta, not one per message: the latest row titles the
//     notification and the row count becomes the alert count;
//   - fire-and-forget: push failures never break a sync.

import { query } from './db.js';
import { buildMailNotificationEvent } from './mailNotificationEvent.js';
import { dispatchMailNotification } from './pushDispatcher.js';

interface NotificationMessageRow {
    id: string;
    account_id: string;
    from_name: string | null;
    from_email: string | null;
    subject: string | null;
}

/**
 * Emit one canonical new-mail event for the given persisted rows.
 *
 * The rows are the ones an incremental Graph or Gmail delta just created in the
 * INBOX. Ingest rules have already run, so unread filtering is both the
 * notification filter and the rule-silencing filter. Returns the number of rows
 * that actually alerted (0 when the delta carried nothing notification-worthy).
 */
export async function dispatchProviderMailNotifications(input: { userId: string; rowIds: readonly string[] }): Promise<number> {
    if (!input.rowIds.length) return 0;
    const rows = (await query<NotificationMessageRow>(
        `SELECT id, account_id, from_name, from_email, subject
           FROM messages
          WHERE id = ANY($1::uuid[])
            AND folder = 'INBOX'
            AND is_read = false
            AND is_deleted = false
          ORDER BY date DESC NULLS LAST, id`,
        [[...input.rowIds]],
    )).rows;
    if (!rows.length) return 0;
    const latest = rows[0];
    // The badge count mirrors the IMAP path: enabled accounts, INBOX, unread. A
    // failure here must not drop the notification, so the count is optional.
    const unreadCount = await query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM messages m
          JOIN email_accounts a ON a.id = m.account_id
          WHERE a.user_id = $1 AND a.enabled = true AND m.folder = 'INBOX' AND m.is_read = false AND m.is_deleted = false`,
        [input.userId],
    ).then(result => result.rows[0]?.total ?? 0).catch(() => null);
    await dispatchMailNotification(buildMailNotificationEvent({
        userId: input.userId,
        message: {
            id: latest.id,
            account_id: latest.account_id,
            fromName: latest.from_name || undefined,
            fromEmail: latest.from_email || undefined,
            subject: latest.subject || undefined,
        },
        alertCount: rows.length,
        ...(unreadCount != null ? { unreadCount } : {}),
    }));
    return rows.length;
}

/** Fire-and-forget wrapper for sync call sites: push errors are non-fatal. */
export function scheduleProviderMailNotifications(input: { userId: string; rowIds: readonly string[] }): void {
    dispatchProviderMailNotifications(input).catch((error: unknown) => {
        console.warn('Provider mail notification error:', error instanceof Error ? error.message : error);
    });
}
