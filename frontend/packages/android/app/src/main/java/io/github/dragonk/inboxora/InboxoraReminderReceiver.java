package io.github.dragonk.inboxora;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Date;

/**
 * Fires an alarm-scheduled calendar reminder as a notification.
 *
 * Two modes, both resolved server-side:
 * - notification: a high-priority card that can be swiped away;
 * - alarm: an insistent full-screen alarm (ringing until dismissed) like
 *   the stock calendar app.
 */
public class InboxoraReminderReceiver extends BroadcastReceiver {
    static final String ACTION_RING = "io.github.dragonk.inboxora.CALENDAR_REMINDER_RING";
    static final String ACTION_STOP = "io.github.dragonk.inboxora.CALENDAR_ALARM_STOP";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            int notificationId = intent.getIntExtra("notificationId", -1);
            if (notificationId != -1) {
                try { NotificationManagerCompat.from(context).cancel(notificationId); } catch (Exception ignored) {}
            }
            return;
        }
        if (!ACTION_RING.equals(action)) return;
        if (!InboxoraNativePlugin.hasNotificationPermission(context)) return;
        postReminder(context, intent);
    }

    private void postReminder(Context context, Intent intent) {
        String key = intent.getStringExtra("key");
        if (key == null || key.isEmpty()) return;
        boolean alarmMode = InboxoraReminderScheduler.MODE_ALARM.equals(intent.getStringExtra("mode"));
        String summary = intent.getStringExtra("summary");
        if (summary == null || summary.isEmpty()) {
            summary = InboxoraNativeLocale.text(context, R.string.native_calendar_reminder_title);
        }
        String body = describe(context, intent);
        int notificationId = InboxoraReminderScheduler.reminderAlarmId(key);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context,
                alarmMode ? InboxoraNativePlugin.CHANNEL_CALENDAR_ALARM : InboxoraNativePlugin.CHANNEL_CALENDAR_REMINDERS)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(summary)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(calendarPendingIntent(context, notificationId))
            .setAutoCancel(!alarmMode)
            .setPriority(alarmMode ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_HIGH)
            .setCategory(alarmMode ? NotificationCompat.CATEGORY_ALARM : NotificationCompat.CATEGORY_EVENT);

        if (alarmMode) {
            // Insistent: keeps ringing until the user acts on it, and stays
            // put (no swipe-away) so a missed alarm is still on the shade.
            builder.setFullScreenIntent(alarmActivityPendingIntent(context, intent, notificationId), true);
            builder.setOngoing(true);
            builder.addAction(R.mipmap.ic_launcher,
                InboxoraNativeLocale.text(context, R.string.native_calendar_alarm_stop),
                stopPendingIntent(context, key, notificationId));
        }

        try {
            android.app.Notification notification = builder.build();
            if (alarmMode) notification.flags |= android.app.Notification.FLAG_INSISTENT;
            NotificationManagerCompat.from(context).notify(notificationId, notification);
        } catch (Exception ignored) {
            // Notification access revoked mid-flight; nothing to do.
        }
    }

    private static String describe(Context context, Intent intent) {
        StringBuilder description = new StringBuilder();
        String calendarName = intent.getStringExtra("calendarName");
        if (calendarName != null && !calendarName.isEmpty()) description.append(calendarName);
        String startsAt = intent.getStringExtra("startsAt");
        if (startsAt != null && !startsAt.isEmpty()) {
            try {
                Date date = Date.from(java.time.Instant.parse(startsAt));
                String formatted = java.text.DateFormat.getDateTimeInstance(
                    java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(date);
                if (description.length() > 0) description.append(" - ");
                description.append(formatted);
            } catch (Exception ignored) {}
        }
        String location = intent.getStringExtra("location");
        if (location != null && !location.isEmpty()) {
            if (description.length() > 0) description.append(" - ");
            description.append(location);
        }
        if (description.length() == 0) {
            description.append(InboxoraNativeLocale.text(context, R.string.native_calendar_reminder_title));
        }
        return description.toString();
    }

    private static PendingIntent calendarPendingIntent(Context context, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("inboxora://calendar"));
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent alarmActivityPendingIntent(Context context, Intent source, int requestCode) {
        Intent intent = new Intent(context, InboxoraAlarmActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("notificationId", requestCode);
        intent.putExtra("summary", source.getStringExtra("summary"));
        intent.putExtra("describe", describe(context, source));
        return PendingIntent.getActivity(context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent stopPendingIntent(Context context, String key, int notificationId) {
        Intent intent = new Intent(context, InboxoraReminderReceiver.class);
        intent.setAction(ACTION_STOP);
        intent.putExtra("notificationId", notificationId);
        return PendingIntent.getBroadcast(context, notificationId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
