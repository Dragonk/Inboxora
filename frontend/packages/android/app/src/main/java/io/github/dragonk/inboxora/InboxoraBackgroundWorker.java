package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import org.json.JSONObject;

/**
 * Periodic reconciliation and fallback — deliberately NOT the primary channel.
 *
 * New mail is delivered instantly by native push (UnifiedPush / FCM). This worker
 * exists so a missed, dropped or not-yet-registered push still surfaces: it
 * compares the server's authoritative unread total against the last baseline and,
 * on an increase, asks the native notification path to post the newest unread
 * message. That path is the same one push uses, so the persisted dedup cache
 * suppresses a second notification for a message push already showed.
 *
 * When the app has a device token it reads the reconciliation snapshot from
 * /api/push/native/inbox; otherwise it falls back to the session-cookie
 * endpoints exactly as before.
 */
public class InboxoraBackgroundWorker extends Worker {
    private static final String PREFS_NAME = "inboxora-background-sync";
    private static final String PREF_LAST_UNREAD_TOTAL = "lastUnreadTotal";

    public InboxoraBackgroundWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void updateUnreadBaseline(Context context, int unreadTotal) {
        if (context == null) return;
        context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putInt(PREF_LAST_UNREAD_TOTAL, Math.max(0, unreadTotal))
            .apply();
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String host = InboxoraNativePlugin.getSavedHost(context);
        if (host == null || host.isEmpty()) return Result.success();

        String deviceToken = InboxoraNativePush.deviceToken(context);
        try {
            if (deviceToken != null && !deviceToken.isEmpty()) {
                return reconcileWithDeviceToken(context, host, deviceToken);
            }
            return reconcileWithCookie(context, host);
        } catch (Exception ignored) {
            return Result.retry();
        }
    }

    private Result reconcileWithDeviceToken(Context context, String host, String deviceToken) throws Exception {
        JSONObject snapshot = getJson(context, host + "/api/push/native/inbox", null, deviceToken);
        int unreadTotal = snapshot.optInt("unreadCount", 0);
        JSONObject message = snapshot.optJSONObject("message");

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int lastUnreadTotal = prefs.getInt(PREF_LAST_UNREAD_TOTAL, -1);

        if (lastUnreadTotal >= 0 && unreadTotal > lastUnreadTotal && message != null) {
            notify(context, message, unreadTotal - lastUnreadTotal);
        }

        updateUnreadBaseline(context, unreadTotal);
        return Result.success();
    }

    private Result reconcileWithCookie(Context context, String host) throws Exception {
        String cookie = CookieManager.getInstance().getCookie(host);
        if (cookie == null || cookie.trim().isEmpty()) return Result.success();

        JSONObject counts = getJson(context, host + "/api/mail/unread-counts", cookie, null);
        int unreadTotal = counts.optInt("total", 0);

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int lastUnreadTotal = prefs.getInt(PREF_LAST_UNREAD_TOTAL, -1);

        if (lastUnreadTotal >= 0 && unreadTotal > lastUnreadTotal) {
            JSONObject latest = getLatestUnreadMessage(host, cookie);
            notify(context, latest, unreadTotal - lastUnreadTotal);
        }

        updateUnreadBaseline(context, unreadTotal);
        return Result.success();
    }

    private static void notify(Context context, JSONObject message, int delta) {
        String title = message.optString("from_name", message.optString("fromName",
            message.optString("from_email", message.optString("fromEmail", "New mail"))));
        String subject = message.optString("subject", null);
        String body = subject == null || subject.isEmpty()
            ? (delta > 1 ? delta + " new messages" : "You have new mail.")
            : subject;

        InboxoraNativePlugin.postNewMailNotification(
            context,
            title == null || title.isEmpty() ? "New mail" : title,
            body,
            // The native endpoints return messageId; the legacy list endpoint returns id.
            message.optString("messageId", message.optString("id", null)),
            message.optString("accountId", message.optString("account_id", null)),
            message.optString("folder", "INBOX"),
            null
        );
    }

    private static JSONObject getLatestUnreadMessage(String host, String cookie) throws Exception {
        JSONObject result = getJson(null, host + "/api/mail/messages?folder=INBOX&limit=1&unreadOnly=true", cookie, null);
        org.json.JSONArray messages = result.optJSONArray("messages");
        if (messages == null || messages.length() == 0) return new JSONObject();
        JSONObject first = messages.optJSONObject(0);
        return first == null ? new JSONObject() : first;
    }

    private static JSONObject getJson(Context context, String url, String cookie, String bearerToken) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        if (bearerToken != null) connection.setRequestProperty("Authorization", "Bearer " + bearerToken);

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
            ? connection.getInputStream()
            : connection.getErrorStream();
        String body = readAll(stream);
        connection.disconnect();

        if (status < 200 || status >= 300) {
            if (status == 401 && bearerToken != null && context != null) {
                // The server revoked/rotated this device token: drop it and let the
                // registration worker issue a fresh one.
                InboxoraNativePush.setDeviceToken(context, null);
                InboxoraNativePush.enqueueRegistration(context);
            }
            throw new IllegalStateException("Inboxora background check failed: HTTP " + status);
        }

        return new JSONObject(body);
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder result = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream));
        String line;
        while ((line = reader.readLine()) != null) result.append(line);
        return result.toString();
    }
}
