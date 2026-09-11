package io.github.dragonk.inboxora;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

public class InboxoraNotificationDedupTest {
    @Test
    public void suppressesTheSameEventUntilTheTtlExpires() {
        InboxoraNotificationDedup dedup = new InboxoraNotificationDedup(null, 1000, 10);
        assertFalse(dedup.isDuplicate("msg-1", 1000));
        dedup.remember("msg-1", 1000);

        assertTrue(dedup.isDuplicate("msg-1", 1500));
        assertFalse(dedup.isDuplicate("msg-1", 2500));
    }

    @Test
    public void treatsDifferentMessagesAsIndependent() {
        InboxoraNotificationDedup dedup = new InboxoraNotificationDedup(null, 1000, 10);
        dedup.remember("msg-1", 1000);
        assertFalse(dedup.isDuplicate("msg-2", 1000));
    }

    @Test
    public void keepsTheCacheBounded() {
        InboxoraNotificationDedup dedup = new InboxoraNotificationDedup(null, 60_000, 3);
        dedup.remember("a", 1);
        dedup.remember("b", 2);
        dedup.remember("c", 3);
        dedup.remember("d", 4);

        Map<String, Long> snapshot = dedup.snapshot();
        assertEquals(3, snapshot.size());
        assertFalse(snapshot.containsKey("a"));
        assertTrue(snapshot.containsKey("d"));
    }

    @Test
    public void restoresPersistedEntriesOnConstruction() {
        Map<String, Long> persisted = new HashMap<>();
        persisted.put("msg-1", 1000L);
        InboxoraNotificationDedup dedup = new InboxoraNotificationDedup(persisted, 1000, 10);
        assertTrue(dedup.isDuplicate("msg-1", 1200));
    }

    @Test
    public void ignoresBlankEventIds() {
        InboxoraNotificationDedup dedup = new InboxoraNotificationDedup(null, 1000, 10);
        assertFalse(dedup.isDuplicate(null, 1));
        assertFalse(dedup.isDuplicate("", 1));
        dedup.remember("", 1);
        assertEquals(0, dedup.snapshot().size());
    }

    @Test
    public void derivesStableNonNegativeNotificationIds() {
        int first = InboxoraNotificationDedup.stableNotificationId("11111111-1111-1111-1111-111111111111");
        int second = InboxoraNotificationDedup.stableNotificationId("11111111-1111-1111-1111-111111111111");
        int other = InboxoraNotificationDedup.stableNotificationId("22222222-2222-2222-2222-222222222222");

        assertEquals(first, second);
        assertTrue(first >= 0);
        assertNotEquals(first, other);
    }
}
