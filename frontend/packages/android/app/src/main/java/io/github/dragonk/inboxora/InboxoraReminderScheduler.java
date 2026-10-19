package io.github.dragonk.inboxora;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Schedules upcoming calendar reminders with AlarmManager.
 *
 * The server resolves the whole cascade (global -> calendar -> event
 * override) and hands the device a flat list of ring moments. The device
 * only decides HOW to ring: a high-priority notification, or a full alarm
 * (setAlarmClock + insistent ringing) like the stock calendar app.
 *
 * Scheduled keys are persisted, so a sync that no longer sees a reminder
 * (moved, deleted, muted) cancels its pending alarm instead of ringing for
 * an event that is gone.
 */
final class InboxoraReminderScheduler {
    static final String MODE_NOTIFICATION = "notification";
    static final String MODE_ALARM = "alarm";
    static final long WINDOW_HOURS = 48;

    /** One upcoming reminder, as resolved server-side. */
    static final class Reminder {
        final String key;
        final String eventId;
        final String summary;
        final String location;
        final String calendarName;
        final String startsAt;
        final String mode;
        final long remindAtMillis;

        Reminder(String key, String eventId, String summary, String location, String calendarName, String startsAt, String mode, long remindAtMillis) {
            this.key = key;
            this.eventId = eventId;
            this.summary = summary;
            this.location = location;
            this.calendarName = calendarName;
            this.startsAt = startsAt;
            this.mode = mode;
            this.remindAtMillis = remindAtMillis;
        }
    }

    private InboxoraReminderScheduler() {}

    /** Fetch the reminder window from the server and make the alarms match it. */
    static boolean sync(Context context) {
        String host = InboxoraNativePlugin.getSavedHost(context);
        String token = InboxoraNativePush.deviceToken(context);
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) return false;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(host + "/api/push/native/reminders?windowHours=" + WINDOW_HOURS).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            String bodyText = readAll(stream);
            connection.disconnect();
            if (status < 200 || status >= 300) return false;
            apply(context, parseReminders(bodyText, System.currentTimeMillis()));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Pure parse of a /native/reminders response; stale entries are dropped. */
    static List<Reminder> parseReminders(String bodyText, long nowMillis) {
        List<Reminder> reminders = new ArrayList<>();
        if (bodyText == null) return reminders;
        try {
            JSONObject body = new JSONObject(bodyText);
            JSONArray array = body.optJSONArray("reminders");
            if (array == null) return reminders;
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) continue;
                String key = item.optString("key", null);
                String remindAt = item.optString("remindAt", null);
                if (key == null || key.isEmpty() || remindAt == null) continue;
                long remindAtMillis;
                try {
                    remindAtMillis = java.time.Instant.parse(remindAt).toEpochMilli();
                } catch (Exception invalid) {
                    continue;
                }
                // A remind moment already far in the past cannot produce a
                // useful alert; a small grace covers clock drift.
                if (remindAtMillis < nowMillis - 60_000) continue;
                String mode = item.optString("mode", MODE_NOTIFICATION);
                if (!MODE_ALARM.equals(mode)) mode = MODE_NOTIFICATION;
                reminders.add(new Reminder(
                    key,
                    item.optString("eventId", null),
                    item.optString("summary", ""),
                    item.optString("location", null),
                    item.optString("calendarName", null),
                    item.optString("startsAt", null),
                    mode,
                    remindAtMillis
                ));
            }
        } catch (Exception ignored) {
            // Malformed payload: keep whatever parsed so far.
        }
        return reminders;
    }

    /** Make the alarm set match the reminder list exactly. */
    static void apply(Context context, List<Reminder> reminders) {
        Set<String> desiredKeys = new HashSet<>();
        for (Reminder reminder : reminders) {
            scheduleAlarm(context, reminder);
            desiredKeys.add(reminder.key);
        }
        Set<String> previousKeys = scheduledKeys(context);
        for (String key : previousKeys) {
            if (!desiredKeys.contains(key)) cancelAlarm(context, key);
        }
        persistScheduledKeys(context, desiredKeys);
    }

    private static AlarmManager alarmManager(Context context) {
        return (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
    }

    static PendingIntent alarmPendingIntent(Context context, Reminder reminder) {
        Intent intent = new Intent(context, InboxoraReminderReceiver.class);
        intent.setAction(InboxoraReminderReceiver.ACTION_RING);
        intent.putExtra("key", reminder.key);
        intent.putExtra("eventId", reminder.eventId);
        intent.putExtra("summary", reminder.summary);
        intent.putExtra("location", reminder.location);
        intent.putExtra("calendarName", reminder.calendarName);
        intent.putExtra("startsAt", reminder.startsAt);
        intent.putExtra("mode", reminder.mode);
        return PendingIntent.getBroadcast(
            context,
            reminderAlarmId(reminder.key),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static void scheduleAlarm(Context context, Reminder reminder) {
        AlarmManager manager = alarmManager(context);
        if (manager == null) return;
        PendingIntent pending = alarmPendingIntent(context, reminder);
        if (MODE_ALARM.equals(reminder.mode)) {
            // setAlarmClock is the strongest scheduling signal Android has:
            // it survives doze and shows the alarm icon, exactly like the
            // stock clock/calendar apps.
            PendingIntent showIntent = PendingIntent.getActivity(
                context,
                reminderAlarmId(reminder.key),
                new Intent(context, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            manager.setAlarmClock(new AlarmManager.AlarmClockInfo(reminder.remindAtMillis, showIntent), pending);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.remindAtMillis, pending);
        } else {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.remindAtMillis, pending);
        }
    }

    static void cancelAlarm(Context context, String key) {
        AlarmManager manager = alarmManager(context);
        if (manager == null) return;
        Reminder placeholder = new Reminder(key, null, null, null, null, null, MODE_NOTIFICATION, 0);
        manager.cancel(alarmPendingIntent(context, placeholder));
    }

    static void cancelAll(Context context) {
        for (String key : scheduledKeys(context)) cancelAlarm(context, key);
        persistScheduledKeys(context, new HashSet<>());
    }

    /** Deterministic per-reminder alarm id, shared with the notification id. */
    static int reminderAlarmId(String key) {
        return InboxoraNotificationDedup.stableNotificationId("reminder:" + key);
    }

    static Set<String> scheduledKeys(Context context) {
        Set<String> keys = new HashSet<>();
        String raw = InboxoraNativePush.prefs(context).getString(InboxoraNativePush.PREF_SCHEDULED_REMINDERS, null);
        if (raw == null || raw.isEmpty()) return keys;
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                String key = array.optString(i);
                if (!key.isEmpty()) keys.add(key);
            }
        } catch (Exception ignored) {}
        return keys;
    }

    static int scheduledCount(Context context) {
        return scheduledKeys(context).size();
    }

    private static void persistScheduledKeys(Context context, Set<String> keys) {
        JSONArray array = new JSONArray();
        for (String key : keys) array.put(key);
        SharedPreferences.Editor editor = InboxoraNativePush.prefs(context).edit();
        editor.putString(InboxoraNativePush.PREF_SCHEDULED_REMINDERS, array.toString());
        editor.apply();
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder result = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) result.append(line);
        return result.toString();
    }
}
