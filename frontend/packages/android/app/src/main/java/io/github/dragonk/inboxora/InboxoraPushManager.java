package io.github.dragonk.inboxora;

import android.content.Context;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.List;
import org.unifiedpush.android.connector.ConstantsKt;
import org.unifiedpush.android.connector.UnifiedPush;

/**
 * Chooses the native push transport and keeps its registration in sync.
 *
 * Order of preference:
 *   1. UnifiedPush — no central service, the user picks (or self-hosts) the
 *      distributor, and the Inboxora server is the only sender. This is the
 *      transport that preserves Inboxora's self-hosted character.
 *   2. FCM — only when this build was compiled with its own Firebase project
 *      ({@code google-services.json}); the self-hoster then owns the sender
 *      credentials too. Nothing Google-specific is required for the app to run.
 *
 * Every call is defensive: a missing distributor or an unconfigured Firebase
 * must never crash the app, it just falls back to the WorkManager reconciler.
 */
final class InboxoraPushManager {
    private InboxoraPushManager() {}

    static void ensureRegistered(Context context) {
        if (context == null) return;
        if (registerUnifiedPush(context)) return;
        registerFcm(context);
    }

    /** @return true when a UnifiedPush distributor is available and registration was requested. */
    static boolean registerUnifiedPush(Context context) {
        try {
            List<String> distributors = UnifiedPush.getDistributors(context);
            if (distributors == null || distributors.isEmpty()) return false;
            UnifiedPush.tryUseCurrentOrDefaultDistributor(context, new kotlin.jvm.functions.Function1<Boolean, kotlin.Unit>() {
                @Override
                public kotlin.Unit invoke(Boolean success) {
                    if (Boolean.TRUE.equals(success)) {
                        try {
                            UnifiedPush.register(context, ConstantsKt.INSTANCE_DEFAULT, null, null);
                        } catch (Throwable ignored) {}
                    }
                    return kotlin.Unit.INSTANCE;
                }
            });
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    static void registerFcm(Context context) {
        try {
            if (FirebaseApp.getApps(context).isEmpty()) return;
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                if (token == null || token.isEmpty()) return;
                InboxoraNativePush.setRegistration(context, InboxoraNativePush.TRANSPORT_FCM, token);
                InboxoraNativePush.enqueueRegistration(context);
            });
        } catch (Throwable ignored) {}
    }

    /** Best-effort provider-side teardown before the local registration is dropped. */
    static void unregister(Context context) {
        if (context == null) return;
        try {
            UnifiedPush.unregister(context, ConstantsKt.INSTANCE_DEFAULT);
        } catch (Throwable ignored) {}
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
        boolean hasEndpoint = InboxoraNativePush.endpoint(context) != null;
        boolean hasDeviceToken = InboxoraNativePush.deviceToken(context) != null;
        if (hasEndpoint && hasDeviceToken) return InboxoraNativePush.STATUS_CONNECTED;
        if (InboxoraNativePlugin.getSavedHost(context) != null) return InboxoraNativePush.STATUS_FALLBACK;
        return InboxoraNativePush.STATUS_UNAVAILABLE;
    }
}
