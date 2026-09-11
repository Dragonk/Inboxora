package io.github.dragonk.inboxora;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Bounded, time-limited dedup cache for "new mail" notifications.
 *
 * Android can learn about the same message through more than one path: the live
 * WebSocket while the WebView is alive, the native push provider, and the
 * periodic WorkManager reconciliation. All of them key on the immutable message
 * UUID the server put in the event, so a message that was already surfaced is
 * never surfaced twice.
 *
 * Pure Java on purpose: the same logic runs in JVM unit tests and on-device.
 */
public final class InboxoraNotificationDedup {
    static final long DEFAULT_TTL_MS = 10 * 60 * 1000L;
    static final int DEFAULT_MAX_ENTRIES = 200;

    private final LinkedHashMap<String, Long> entries = new LinkedHashMap<>();
    private final long ttlMs;
    private final int maxEntries;

    public InboxoraNotificationDedup(Map<String, Long> initial, long ttlMs, int maxEntries) {
        this.ttlMs = ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
        this.maxEntries = maxEntries > 0 ? maxEntries : DEFAULT_MAX_ENTRIES;
        if (initial != null) entries.putAll(initial);
        prune(Long.MAX_VALUE);
    }

    public synchronized boolean isDuplicate(String eventId, long now) {
        if (eventId == null || eventId.isEmpty()) return false;
        prune(now);
        Long seenAt = entries.get(eventId);
        return seenAt != null && now - seenAt < ttlMs;
    }

    public synchronized void remember(String eventId, long now) {
        if (eventId == null || eventId.isEmpty()) return;
        entries.remove(eventId);
        entries.put(eventId, now);
        prune(now);
    }

    /** Entries to persist, bounded to the most recent {@code maxEntries}. */
    public synchronized Map<String, Long> snapshot() {
        return new LinkedHashMap<>(entries);
    }

    private void prune(long now) {
        if (now == Long.MAX_VALUE) {
            while (entries.size() > maxEntries) removeOldest();
            return;
        }
        entries.entrySet().removeIf((entry) -> now - entry.getValue() >= ttlMs);
        while (entries.size() > maxEntries) removeOldest();
    }

    private void removeOldest() {
        String oldest = null;
        for (String key : entries.keySet()) {
            oldest = key;
            break;
        }
        if (oldest != null) entries.remove(oldest);
    }

    /**
     * Deterministic, stable notification id for a message, so a repeated event
     * for the same message updates one notification instead of stacking.
     */
    public static int stableNotificationId(String eventId) {
        if (eventId == null || eventId.isEmpty()) return "inboxora-new-mail".hashCode() & 0x7fffffff;
        int hash = 0x811c9dc5;
        for (int i = 0; i < eventId.length(); i++) {
            hash ^= eventId.charAt(i);
            hash *= 0x01000193;
        }
        return hash & 0x7fffffff;
    }
}
