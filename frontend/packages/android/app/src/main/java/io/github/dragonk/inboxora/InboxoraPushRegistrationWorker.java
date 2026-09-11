package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Registers (or refreshes) this install's provider endpoint with the user's own
 * Inboxora server: POST /api/push/devices.
 *
 * The session cookie authenticates the call — the user id is taken from the
 * session server-side, so a device can only ever register itself. The server
 * answers with a one-time device token, which is stored encrypted for the
 * background fetch workers. Registering again (app start, token rotation, host
 * change) rotates that token, so a lost token self-heals.
 */
public class InboxoraPushRegistrationWorker extends Worker {
    private static final int HTTP_UNAUTHORIZED = 401;
    private static final int HTTP_BAD_REQUEST = 400;

    public InboxoraPushRegistrationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String host = InboxoraNativePlugin.getSavedHost(context);
        if (host == null || host.isEmpty()) return Result.success();

        // Not logged in yet, or no distributor/endpoint available: nothing to do
        // now. Returning success (instead of retry) avoids an endless background
        // retry loop on devices that never install a distributor — the next
        // launch, login or onNewEndpoint callback enqueues registration again.
        String cookie = CookieManager.getInstance().getCookie(host);
        if (cookie == null || cookie.trim().isEmpty()) return Result.success();

        String transport = InboxoraNativePush.transport(context);
        String endpoint = InboxoraNativePush.endpoint(context);
        if (transport == null || endpoint == null || endpoint.isEmpty()) {
            InboxoraPushManager.ensureRegistered(context);
            return Result.success();
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("deviceId", InboxoraNativePush.deviceId(context));
            payload.put("platform", "android");
            payload.put("transport", transport);
            payload.put("endpoint", endpoint);
            String appVersion = appVersion(context);
            if (appVersion != null) payload.put("appVersion", appVersion);

            Response response = post(host + "/api/push/devices", cookie, payload.toString());
            if (response.status == HTTP_UNAUTHORIZED) {
                // Session expired or signed out. Re-registration happens on the
                // next launch/login; do not keep waking the device for this.
                InboxoraNativePush.setStatus(context, InboxoraNativePush.STATUS_FALLBACK);
                return Result.success();
            }
            if (response.status == HTTP_BAD_REQUEST) {
                // The server rejected this endpoint (e.g. a blocked private
                // distributor URL). Retrying cannot help; surface it in settings.
                InboxoraNativePush.setStatus(context, InboxoraNativePush.STATUS_UNAVAILABLE);
                return Result.failure();
            }
            if (response.status < 200 || response.status >= 300) return Result.retry();

            JSONObject body = new JSONObject(response.body);
            String deviceToken = body.optString("deviceToken", null);
            if (deviceToken == null || deviceToken.isEmpty()) return Result.retry();

            InboxoraNativePush.setDeviceToken(context, deviceToken);
            InboxoraNativePush.setRegisteredHost(context, host);
            InboxoraNativePush.setStatus(context, InboxoraNativePush.STATUS_CONNECTED);
            return Result.success();
        } catch (Exception ignored) {
            return Result.retry();
        }
    }

    private static String appVersion(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName;
        } catch (Exception ignored) {
            return null;
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

    static Response post(String url, String cookie, String jsonBody) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json");
        // Required by the server's CSRF guard for every mutating /api request.
        connection.setRequestProperty("X-Requested-With", "MailFlow");
        connection.setRequestProperty("Cookie", cookie);

        byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(bytes);
        }

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
