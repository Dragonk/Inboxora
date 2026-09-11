package io.github.dragonk.inboxora;

import android.content.Context;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import org.json.JSONObject;

/**
 * Persists the bounded notification dedup cache.
 *
 * The cache survives process death on purpose: a notification delivered by
 * native push must not be repeated by the WorkManager reconciler (or by the
 * live WebSocket) after Android restarts the WebView process.
 */
final class InboxoraNotificationDedupStore {
    private static final String PREF_KEY = "notification_dedup";
    static final Object LOCK = new Object();

    private InboxoraNotificationDedupStore() {}

    static InboxoraNotificationDedup load(Context context) {
        Map<String, Long> entries = new HashMap<>();
        String raw = InboxoraNativePush.prefs(context).getString(PREF_KEY, null);
        if (raw != null && !raw.isEmpty()) {
            try {
                JSONObject json = new JSONObject(raw);
                Iterator<String> keys = json.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    entries.put(key, json.optLong(key));
                }
            } catch (Exception ignored) {}
        }
        return new InboxoraNotificationDedup(
            entries,
            InboxoraNotificationDedup.DEFAULT_TTL_MS,
            InboxoraNotificationDedup.DEFAULT_MAX_ENTRIES
        );
    }

    static void save(Context context, InboxoraNotificationDedup dedup) {
        try {
            JSONObject json = new JSONObject();
            for (Map.Entry<String, Long> entry : dedup.snapshot().entrySet()) {
                json.put(entry.getKey(), entry.getValue());
            }
            InboxoraNativePush.prefs(context).edit().putString(PREF_KEY, json.toString()).apply();
        } catch (Exception ignored) {}
    }

    /** Drop the cache on logout / host change so a new account starts clean. */
    static void clear(Context context) {
        InboxoraNativePush.prefs(context).edit().remove(PREF_KEY).apply();
    }
}
