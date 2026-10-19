package io.github.dragonk.inboxora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class InboxoraReminderSchedulerTest {
    private static final String NOW = "2026-10-19T12:00:00Z";
    private static final long NOW_MS = 1792411200000L;

    @Test
    public void parsesRemindersFromAServerResponse() throws Exception {
        JSONObject body = new JSONObject();
        body.put("reminders", new org.json.JSONArray()
            .put(new JSONObject()
                .put("key", "event-1")
                .put("eventId", "event-1")
                .put("summary", "Dentist")
                .put("calendarName", "Personal")
                .put("location", "Clinic")
                .put("startsAt", "2026-10-19T12:30:00Z")
                .put("remindAt", NOW)
                .put("mode", "alarm"))
            .put(new JSONObject()
                .put("key", "event-2@20261020")
                .put("eventId", "event-2")
                .put("summary", "Standup")
                .put("startsAt", "2026-10-20T09:00:00Z")
                .put("remindAt", "2026-10-20T08:30:00Z")
                .put("mode", "unknown")));

        List<InboxoraReminderScheduler.Reminder> reminders =
            InboxoraReminderScheduler.parseReminders(body.toString(), NOW_MS);

        assertEquals(2, reminders.size());
        assertEquals("event-1", reminders.get(0).key);
        assertEquals(InboxoraReminderScheduler.MODE_ALARM, reminders.get(0).mode);
        assertEquals(NOW_MS, reminders.get(0).remindAtMillis);
        assertEquals("Dentist", reminders.get(0).summary);
        // An unknown mode is downgraded to a plain notification.
        assertEquals(InboxoraReminderScheduler.MODE_NOTIFICATION, reminders.get(1).mode);
    }

    @Test
    public void dropsStaleRemindersOutsideTheGraceWindow() throws Exception {
        JSONObject body = new JSONObject();
        body.put("reminders", new org.json.JSONArray()
            .put(new JSONObject().put("key", "old").put("remindAt", "2026-10-19T10:00:00Z"))
            .put(new JSONObject().put("key", "grace").put("remindAt", "2026-10-19T11:59:30Z"))
            .put(new JSONObject().put("key", "future").put("remindAt", "2026-10-19T13:00:00Z")));

        List<InboxoraReminderScheduler.Reminder> reminders =
            InboxoraReminderScheduler.parseReminders(body.toString(), NOW_MS);

        // 10:00 is two hours stale: dropped. 11:59:30 is within the 60s
        // drift grace: kept.
        assertEquals(2, reminders.size());
        assertEquals("grace", reminders.get(0).key);
        assertEquals("future", reminders.get(1).key);
    }

    @Test
    public void survivesMalformedPayloads() throws Exception {
        assertTrue(InboxoraReminderScheduler.parseReminders("not json", NOW_MS).isEmpty());
        assertTrue(InboxoraReminderScheduler.parseReminders("{}", NOW_MS).isEmpty());
        assertTrue(InboxoraReminderScheduler.parseReminders(null, NOW_MS).isEmpty());
        JSONObject missingKey = new JSONObject();
        missingKey.put("reminders", new org.json.JSONArray().put(new JSONObject().put("eventId", "no-key")));
        assertTrue(InboxoraReminderScheduler.parseReminders(missingKey.toString(), NOW_MS).isEmpty());
    }

    @Test
    public void reminderAlarmIdsAreStableAndDistinct() {
        assertEquals(InboxoraReminderScheduler.reminderAlarmId("event-1"), InboxoraReminderScheduler.reminderAlarmId("event-1"));
        assertTrue(InboxoraReminderScheduler.reminderAlarmId("event-1") != InboxoraReminderScheduler.reminderAlarmId("event-2"));
        assertTrue(InboxoraReminderScheduler.reminderAlarmId("event-1") != InboxoraNotificationDedup.stableNotificationId("event-1"));
        assertNotNull(InboxoraReminderScheduler.reminderAlarmId("event-1"));
    }
}
