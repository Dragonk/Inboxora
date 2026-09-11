package io.github.dragonk.inboxora;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Turns an opaque push wake-up into a native notification.
 *
 * The external provider only ever told us "mail.changed" plus the message's
 * opaque event id; the sender, subject and body are fetched here, over the
 * device token, straight from the user's own Inboxora server. When the event id
 * is missing (or the message has already moved), the worker reconciles against
 * the server's unread snapshot instead — the same code path the WorkManager
 * fallback uses, so both are deduplicated against each other.
 */
public class InboxoraPushFetchWorker extends Worker {
    private static final int HTTP_UNAUTHORIZED = 401;
    private static final int HTTP_NOT_FOUND = 404;

    public InboxoraPushFetchWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        if (!InboxoraNativePlugin.hasNotificationPermission(context)) return Result.success();

        String host = InboxoraNativePlugin.getSavedHost(context);
        if (host == null || host.isEmpty()) return Result.success();

        String deviceToken = InboxoraNativePush.deviceToken(context);
        if (deviceToken == null || deviceToken.isEmpty()) {
            // Registration has not completed (or the token was revoked). Nudge it;
            // the next reconciliation will surface the message if it is still unread.
            InboxoraNativePush.enqueueRegistration(context);
            return Result.retry();
        }

        String eventId = getInputData().getString(InboxoraNativePush.KEY_EVENT_ID);
        String path = eventId == null || eventId.isEmpty()
            ? "/api/push/native/inbox"
            : "/api/push/native/messages/" + eventId;

        try {
            Response response = get(host + path, deviceToken);
            if (response.status == HTTP_UNAUTHORIZED) {
                InboxoraNativePush.setDeviceToken(context, null);
                InboxoraNativePush.setStatus(context, InboxoraNativePush.STATUS_UNAVAILABLE);
                InboxoraNativePush.enqueueRegistration(context);
                return Result.retry();
            }
            if (response.status == HTTP_NOT_FOUND) return Result.success();
            if (response.status < 200 || response.status >= 300) return Result.retry();

            JSONObject body = new JSONObject(response.body);
            JSONObject message = body.optJSONObject("message");
            if (message == null) return Result.success();

            InboxoraNativePlugin.postNewMailNotification(
                context,
                message.optString("title", "New mail"),
                message.optString("body", "You have new mail."),
                message.optString("messageId", null),
                message.optString("accountId", null),
                message.optString("folder", "INBOX"),
                null
            );
            return Result.success();
        } catch (Exception ignored) {
            // Network blip while the server is unreachable: keep the event queued
            // (WorkManager backoff) instead of dropping the notification.
            return Result.retry();
        }
    }

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    static Response get(String url, String deviceToken) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Authorization", "Bearer " + deviceToken);

        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300
            ? connection.getInputStream()
            : connection.getErrorStream();
        String body = readAll(stream);
        connection.disconnect();
        return new Response(status, body);
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
