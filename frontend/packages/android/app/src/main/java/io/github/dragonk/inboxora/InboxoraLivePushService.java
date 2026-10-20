package io.github.dragonk.inboxora;

import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import java.util.List;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Foreground service that keeps the app's own WebSocket to the Inboxora
 * server alive, with no external push provider involved.
 *
 * It authenticates with the same revocable device token the
 * /api/push/native mount uses, so the socket is scoped to one user. The
 * server streams three kinds of events this service acts on:
 * - new_messages: post a native notification per message (the shared
 *   dedup store keeps the live path, the provider path and the reconciler
 *   from double-notifying);
 * - message_flags: a message read anywhere dismisses its notification;
 * - mail_state_changed: debounced reconciliation against
 *   /api/push/native/read-check cancels notifications whose message is no
 *   longer unread - reading mail in the app or on any other device clears
 *   every hanging card.
 */
public class InboxoraLivePushService extends android.app.Service {
    private static final long RECONNECT_MIN_MS = 1000;
    private static final long RECONNECT_MAX_MS = 30_000;
    private static final long RECONCILE_DEBOUNCE_MS = 3000;
    private static final int FOREGROUND_NOTIFICATION_ID = 0x4c495645; // LIVE

    private static volatile boolean started = false;
    private final Object connectionLock = new Object();
    private OkHttpClient client;
    private WebSocket socket;
    private Thread reconnectThread;
    private Thread reconcileThread;
    private volatile boolean running;
    private volatile long backoffMs = RECONNECT_MIN_MS;

    /** Idempotent start: safe on every app launch and on boot. */
    public static void ensureStarted(Context context) {
        if (context == null) return;
        // FCM builds are woken by the provider: a socket of our own would only
        // add a foreground notification with no benefit.
        if (InboxoraNativePush.TRANSPORT_FCM.equals(InboxoraNativePush.transport(context))) return;
        String host = InboxoraNativePlugin.getSavedHost(context);
        String token = InboxoraNativePush.deviceToken(context);
        // No configured server or not-yet-registered device token: nothing to
        // connect with yet. Registration/token arrival re-invokes ensureStarted.
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, InboxoraLivePushService.class));
        } catch (Exception ignored) {}
    }

    public static void stop(Context context) {
        if (context == null) return;
        try { context.stopService(new Intent(context, InboxoraLivePushService.class)); } catch (Exception ignored) {}
        InboxoraNativePush.setLiveStatus(context, InboxoraNativePush.STATUS_UNAVAILABLE);
    }

    /**
     * Deep-link to the live-push notification channel settings. Android requires
     * a foreground service to show a notification, but the channel can be turned
     * off there — the socket keeps running, only the persistent card disappears
     * from the shade.
     */
    public static void openChannelSettings(Context context) {
        if (context == null) return;
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, InboxoraNativePlugin.CHANNEL_LIVE_PUSH)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.getPackageName())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Throwable ignored) {}
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        startInForeground();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // The service holds one socket for the lifetime of the process; an
        // extra start (host change, re-registration) just refreshes it.
        connect();
        if (!started) { started = true; }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        closeSocket();
        if (reconnectThread != null) reconnectThread.interrupt();
        if (reconcileThread != null) reconcileThread.interrupt();
        started = false;
        InboxoraNativePush.setLiveStatus(this, InboxoraNativePush.STATUS_UNAVAILABLE);
        super.onDestroy();
    }

    private void startInForeground() {
        Notification notification = new NotificationCompat.Builder(this, InboxoraNativePlugin.CHANNEL_LIVE_PUSH)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(InboxoraNativeLocale.text(this, R.string.native_live_push_title))
            .setContentText(InboxoraNativeLocale.text(this, R.string.native_live_push_body))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(mainActivityIntent())
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification);
        }
    }

    private PendingIntent mainActivityIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, FOREGROUND_NOTIFICATION_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void connect() {
        synchronized (connectionLock) {
            if (!running) return;
            String host = InboxoraNativePlugin.getSavedHost(this);
            String token = InboxoraNativePush.deviceToken(this);
            if (host == null || host.isEmpty() || token == null || token.isEmpty()) {
                stopSelf();
                return;
            }
            closeSocket();
            if (client == null) {
                client = new OkHttpClient.Builder()
                    .pingInterval(30, TimeUnit.SECONDS)
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.MILLISECONDS)
                    .build();
            }
            Request request = new Request.Builder()
                .url(host + "/api/push/native/ws")
                .header("Authorization", "Bearer " + token)
                .build();
            InboxoraNativePush.setLiveStatus(this, InboxoraNativePush.STATUS_FALLBACK);
            socket = client.newWebSocket(request, listener);
        }
    }

    private void closeSocket() {
        if (socket != null) {
            try { socket.close(1000, "Stopping"); } catch (Exception ignored) {}
            socket = null;
        }
    }

    private final WebSocketListener listener = new WebSocketListener() {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            backoffMs = RECONNECT_MIN_MS;
            InboxoraNativePush.setLiveStatus(InboxoraLivePushService.this, InboxoraNativePush.STATUS_CONNECTED);
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            handleEvent(text);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            InboxoraNativePush.setLiveStatus(InboxoraLivePushService.this, InboxoraNativePush.STATUS_UNAVAILABLE);
            scheduleReconnect();
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            InboxoraNativePush.setLiveStatus(InboxoraLivePushService.this, InboxoraNativePush.STATUS_UNAVAILABLE);
            scheduleReconnect();
        }
    };

    private void scheduleReconnect() {
        if (!running) return;
        long waitMs = backoffMs + Math.abs(deviceHash()) % 1000;
        backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
        synchronized (connectionLock) {
            if (reconnectThread != null && reconnectThread.isAlive()) return;
            reconnectThread = new Thread(() -> {
                try {
                    Thread.sleep(waitMs);
                } catch (InterruptedException interrupted) {
                    return;
                }
                if (running) connect();
            }, "Inboxora-live-reconnect");
            reconnectThread.start();
        }
    }

    /** Stable per-device jitter seed: a fleet of devices does not retry in lockstep against a recovering server. */
    private int deviceHash() {
        String deviceId = InboxoraNativePush.deviceId(this);
        return deviceId == null ? 0 : deviceId.hashCode();
    }

    private void handleEvent(String text) {
        try {
            JSONObject event = new JSONObject(text);
            String type = event.optString("type");
            if ("new_messages".equals(type)) {
                handleNewMessages(event);
            } else if ("message_flags".equals(type)) {
                handleMessageFlags(event);
            } else if ("mail_state_changed".equals(type)) {
                scheduleReconcile();
            }
        } catch (Exception ignored) {
            // Unknown or malformed event: the reconciler covers the gap.
        }
    }

    private void handleNewMessages(JSONObject event) {
        String folder = event.optString("folder", "INBOX");
        if (folder == null || !folder.equals("INBOX")) return;
        // alertMessages excludes mail silenced by a mark_read rule; fall back
        // to the full payload for servers that do not send the alert fields.
        JSONArray messages = event.optJSONArray("alertMessages");
        if (messages == null || messages.length() == 0) messages = event.optJSONArray("messages");
        if (messages == null) return;
        String accountId = event.optString("accountId", null);
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message == null) continue;
            String id = message.optString("id", null);
            if (id == null || id.isEmpty()) continue;
            InboxoraNativePlugin.postNewMailNotification(
                this,
                InboxoraNotificationText.title(
                    message, InboxoraNativeLocale.text(this, R.string.native_new_mail)),
                InboxoraNotificationText.body(
                    message,
                    1,
                    InboxoraNativeLocale.text(this, R.string.native_new_mail_body),
                    InboxoraNativeLocale.text(this, R.string.native_new_mail_count)),
                id,
                accountId,
                "INBOX",
                null
            );
        }
    }

    private void handleMessageFlags(JSONObject event) {
        JSONArray changes = event.optJSONArray("changes");
        if (changes == null) return;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.optJSONObject(i);
            if (change == null) continue;
            String id = change.optString("id", null);
            if (id == null || id.isEmpty()) continue;
            // The server sends snake_case keys (is_read, is_starred).
            boolean isRead = change.optBoolean("is_read", false);
            if (isRead) cancelMessageNotification(this, id);
        }
    }

    /** Cancel one message's notification and forget its dedup entry. */
    static void cancelMessageNotification(Context context, String eventId) {
        try {
            androidx.core.app.NotificationManagerCompat.from(context)
                .cancel(InboxoraNotificationDedup.stableNotificationId(eventId));
        } catch (Exception ignored) {}
        synchronized (InboxoraNotificationDedupStore.LOCK) {
            InboxoraNotificationDedup dedup = InboxoraNotificationDedupStore.load(context);
            dedup.forget(eventId);
            InboxoraNotificationDedupStore.save(context, dedup);
        }
    }

    /** Debounced reconciliation: cancel notifications whose message left the unread set. */
    private void scheduleReconcile() {
        Thread pending = new Thread(() -> {
            try {
                Thread.sleep(RECONCILE_DEBOUNCE_MS);
            } catch (InterruptedException interrupted) {
                return;
            }
            if (!running) return;
            reconcileNow();
        }, "Inboxora-live-reconcile");
        Thread previous;
        synchronized (this) {
            previous = reconcileThread;
            reconcileThread = pending;
        }
        if (previous != null) previous.interrupt();
        pending.start();
    }

    private void reconcileNow() {
        List<String> ids;
        synchronized (InboxoraNotificationDedupStore.LOCK) {
            ids = InboxoraNotificationDedupStore.load(this).activeEventIds();
        }
        if (ids.isEmpty()) return;
        String host = InboxoraNativePlugin.getSavedHost(this);
        String token = InboxoraNativePush.deviceToken(this);
        if (host == null || host.isEmpty() || token == null || token.isEmpty()) return;
        try {
            JSONArray bodyIds = new JSONArray();
            for (String id : ids) bodyIds.put(id);
            JSONObject body = new JSONObject();
            body.put("messageIds", bodyIds);
            Response response = postJson(host + "/api/push/native/read-check", token, body.toString());
            if (response == null || response.code() < 200 || response.code() >= 300) return;
            String responseBody = response.body() == null ? "{}" : response.body().string();
            JSONObject parsed = new JSONObject(responseBody);
            JSONArray unread = parsed.optJSONArray("unread");
            java.util.Set<String> stillUnread = new java.util.HashSet<>();
            if (unread != null) {
                for (int i = 0; i < unread.length(); i++) stillUnread.add(unread.optString(i));
            }
            for (String id : ids) {
                if (!stillUnread.contains(id)) cancelMessageNotification(this, id);
            }
        } catch (Exception ignored) {
            // Transient failure: the next mail_state_changed retries.
        }
    }

    private Response postJson(String url, String token, String body) throws Exception {
        // OkHttp's WebSocket client is fine for plain POSTs too; reusing the
        // same client keeps one shared connection pool.
        Request request = new Request.Builder()
            .url(url)
            .header("Authorization", "Bearer " + token)
            .post(okhttp3.RequestBody.create(body, okhttp3.MediaType.parse("application/json")))
            .build();
        return client == null ? null : client.newCall(request).execute();
    }
}
