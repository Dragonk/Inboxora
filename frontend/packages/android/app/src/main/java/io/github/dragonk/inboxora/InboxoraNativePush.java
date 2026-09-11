package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/**
 * Shared state and helpers for the native push path.
 *
 * Provider-specific receivers (UnifiedPush service, FCM service) do almost
 * nothing: they store the endpoint/token or extract the opaque event id and
 * hand the real work to WorkManager. That keeps the receiver inside Android's
 * short execution window and gives us retries, a network constraint and no
 * long-running connection of our own.
 */
final class InboxoraNativePush {
    static final String PREFS_NAME = "inboxora-native";
    static final String PREF_DEVICE_ID = "push_device_id";
    static final String PREF_TRANSPORT = "push_transport";
    static final String PREF_REGISTERED_HOST = "push_registered_host";
    static final String PREF_STATUS = "push_status";

    static final String SECRET_DEVICE_TOKEN = "push_device_token";
    // The provider endpoint/token is a bearer credential for the provider, so it
    // is kept in the encrypted store too — not in plain SharedPreferences.
    static final String SECRET_ENDPOINT = "push_endpoint";

    static final String KEY_EVENT_ID = "eventId";

    static final String WORK_FETCH = "inboxora-push-fetch";
    static final String WORK_REGISTER = "inboxora-push-register";

    static final String TRANSPORT_UNIFIEDPUSH = "unifiedpush";
    static final String TRANSPORT_FCM = "fcm";

    // Settings-facing states, mirrored by the InboxoraNative JS bridge.
    static final String STATUS_CONNECTED = "connected";
    static final String STATUS_UNAVAILABLE = "unavailable";
    static final String STATUS_PERMISSION_DENIED = "permission_denied";
    static final String STATUS_FALLBACK = "fallback";

    private InboxoraNativePush() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** Stable per-install id; generated once and kept for the life of the data. */
    static String deviceId(Context context) {
        SharedPreferences prefs = prefs(context);
        String existing = prefs.getString(PREF_DEVICE_ID, null);
        if (existing != null && !existing.isEmpty()) return existing;
        String generated = UUID.randomUUID().toString();
        prefs.edit().putString(PREF_DEVICE_ID, generated).apply();
        return generated;
    }

    static void setRegistration(Context context, String transport, String endpoint) {
        InboxoraSecretStore.put(context, SECRET_ENDPOINT, endpoint);
        prefs(context).edit()
            .putString(PREF_TRANSPORT, transport)
            .putString(PREF_STATUS, endpoint == null ? STATUS_UNAVAILABLE : STATUS_CONNECTED)
            .apply();
    }

    static String transport(Context context) {
        return prefs(context).getString(PREF_TRANSPORT, null);
    }

    static String endpoint(Context context) {
        return InboxoraSecretStore.get(context, SECRET_ENDPOINT);
    }

    static void setStatus(Context context, String status) {
        prefs(context).edit().putString(PREF_STATUS, status).apply();
    }

    static String status(Context context) {
        return prefs(context).getString(PREF_STATUS, STATUS_UNAVAILABLE);
    }

    static String deviceToken(Context context) {
        return InboxoraSecretStore.get(context, SECRET_DEVICE_TOKEN);
    }

    static void setDeviceToken(Context context, String token) {
        if (token == null) InboxoraSecretStore.remove(context, SECRET_DEVICE_TOKEN);
        else InboxoraSecretStore.put(context, SECRET_DEVICE_TOKEN, token);
    }

    /** Forget every local trace of the previous account/host subscription. */
    static void clearRegistration(Context context) {
        prefs(context).edit()
            .remove(PREF_TRANSPORT)
            .remove(PREF_REGISTERED_HOST)
            .putString(PREF_STATUS, STATUS_UNAVAILABLE)
            .apply();
        InboxoraSecretStore.remove(context, SECRET_ENDPOINT);
        InboxoraSecretStore.remove(context, SECRET_DEVICE_TOKEN);
    }

    static void setRegisteredHost(Context context, String host) {
        prefs(context).edit().putString(PREF_REGISTERED_HOST, host).apply();
    }

    static String registeredHost(Context context) {
        return prefs(context).getString(PREF_REGISTERED_HOST, null);
    }

    static void enqueueFetch(Context context, String eventId) {
        if (context == null) return;
        Data input = new Data.Builder().putString(KEY_EVENT_ID, eventId).build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(InboxoraPushFetchWorker.class)
            .setInputData(input)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        try {
            WorkManager.getInstance(context.getApplicationContext())
                .enqueueUniqueWork(WORK_FETCH, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
        } catch (Exception ignored) {}
    }

    static void enqueueRegistration(Context context) {
        if (context == null) return;
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(InboxoraPushRegistrationWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build();
        try {
            WorkManager.getInstance(context.getApplicationContext())
                .enqueueUniqueWork(WORK_REGISTER, ExistingWorkPolicy.REPLACE, request);
        } catch (Exception ignored) {}
    }

    /**
     * The provider payload is opaque by design: { "type": "mail.changed",
     * "eventId": "<message uuid>" }. Anything unparseable yields null, and the
     * fetch worker then reconciles from the server instead of guessing.
     */
    static String parseEventId(byte[] payload) {
        if (payload == null || payload.length == 0) return null;
        try {
            JSONObject json = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            String eventId = json.optString("eventId", null);
            return eventId == null || eventId.isEmpty() ? null : eventId;
        } catch (Exception ignored) {
            return null;
        }
    }
}
