package io.github.dragonk.inboxora;

import android.content.Context;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Chooses the native push transport and keeps its registration in sync.
 *
 * Order of preference:
 *   1. live — the app's own always-on WebSocket to the user's Inboxora server,
 *      authenticated with the push device token. No external service, no
 *      distributor app: this is the built-in transport.
 *   2. FCM — only when this build was compiled with its own Firebase project
 *      ({@code google-services.json}); the self-hoster then owns the sender
 *      credentials too. Nothing Google-specific is required for the app to run.
 *
 * Every call is defensive: an unconfigured Firebase must never crash the app,
 * it just falls back to the live transport and the WorkManager reconciler.
 */
final class InboxoraPushManager {
    private InboxoraPushManager() {}

    static void ensureRegistered(Context context) {
        if (context == null) return;
        if (registerFcm(context)) return;
        registerLive(context);
    }

    /** @return true when this build has Firebase and registration was requested. */
    static boolean registerFcm(Context context) {
        try {
            if (FirebaseApp.getApps(context).isEmpty()) return false;
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                if (token == null || token.isEmpty()) return;
                InboxoraNativePush.setRegistration(context, InboxoraNativePush.TRANSPORT_FCM, token);
                // The provider wakes the app: a socket of our own would only add
                // a foreground notification with no benefit.
                InboxoraLivePushService.stop(context);
                InboxoraNativePush.enqueueRegistration(context);
            });
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** The built-in transport: no endpoint, the device token is the credential. */
    static void registerLive(Context context) {
        if (context == null) return;
        InboxoraNativePush.setRegistration(context, InboxoraNativePush.TRANSPORT_LIVE, null);
        InboxoraNativePush.enqueueRegistration(context);
    }

    /** Best-effort provider-side teardown before the local registration is dropped. */
    static void unregister(Context context) {
        if (context == null) return;
        try {
            if (!FirebaseApp.getApps(context).isEmpty()) FirebaseMessaging.getInstance().deleteToken();
        } catch (Throwable ignored) {}
        InboxoraNativePush.clearRegistration(context);
    }

    static String status(Context context) {
        if (context == null) return InboxoraNativePush.STATUS_UNAVAILABLE;
        if (!InboxoraNativePlugin.hasNotificationPermission(context)) {
            return InboxoraNativePush.STATUS_PERMISSION_DENIED;
        }
        if (InboxoraNativePush.deviceToken(context) == null) {
            // Not registered with the server yet.
            return InboxoraNativePlugin.getSavedHost(context) != null
                ? InboxoraNativePush.STATUS_FALLBACK
                : InboxoraNativePush.STATUS_UNAVAILABLE;
        }
        if (InboxoraNativePush.TRANSPORT_FCM.equals(InboxoraNativePush.transport(context))) {
            return InboxoraNativePush.STATUS_CONNECTED;
        }
        // Live: connected only while the app's own socket actually is.
        return InboxoraNativePush.STATUS_CONNECTED.equals(InboxoraNativePush.liveStatus(context))
            ? InboxoraNativePush.STATUS_CONNECTED
            : InboxoraNativePush.STATUS_FALLBACK;
    }
}
