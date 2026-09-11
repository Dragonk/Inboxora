package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
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

    // ── Distributor discovery / UX helpers ──────────────────────────────────────

    // The ntfy Android app is the recommended UnifiedPush distributor, but any
    // compatible one works — these are only used to open/install the right app.
    private static final String NTFY_PACKAGE = "io.heckel.ntfy";
    private static final String NTFY_FDROID_URL = "https://f-droid.org/packages/io.heckel.ntfy/";
    private static final String DOCS_URL = "https://github.com/Dragonk/Inboxora/wiki/Notifications";

    /** Installed UnifiedPush distributors (package names). Never throws. */
    static List<String> distributors(Context context) {
        if (context == null) return Collections.emptyList();
        try {
            List<String> list = UnifiedPush.getDistributors(context);
            return list == null ? Collections.emptyList() : list;
        } catch (Throwable ignored) {
            return Collections.emptyList();
        }
    }

    static String savedDistributor(Context context) {
        if (context == null) return null;
        try {
            String saved = UnifiedPush.getSavedDistributor(context);
            return saved == null || saved.isEmpty() ? null : saved;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /** Human-readable app label for a package, or null when it is not installed. */
    static String distributorLabel(Context context, String packageName) {
        if (context == null || packageName == null) return null;
        try {
            PackageManager manager = context.getPackageManager();
            ApplicationInfo info = manager.getApplicationInfo(packageName, 0);
            CharSequence label = manager.getApplicationLabel(info);
            return label == null ? null : label.toString();
        } catch (Throwable ignored) {
            return null;
        }
    }

    /** The distributor to talk about in the UI: saved first, then ntfy, then any. */
    static String preferredDistributor(Context context) {
        String saved = savedDistributor(context);
        if (saved != null) return saved;
        List<String> installed = distributors(context);
        if (installed.contains(NTFY_PACKAGE)) return NTFY_PACKAGE;
        return installed.isEmpty() ? null : installed.get(0);
    }

    /**
     * Bring the distributor app to the front so the user can set
     * "https://<their host>/push" as its server. Returns false when no
     * distributor app is installed.
     */
    static boolean openDistributorApp(Context context) {
        if (context == null) return false;
        Set<String> candidates = new LinkedHashSet<>();
        String preferred = preferredDistributor(context);
        if (preferred != null) candidates.add(preferred);
        candidates.add(NTFY_PACKAGE);
        candidates.addAll(distributors(context));
        for (String packageName : candidates) {
            try {
                Intent intent = context.getPackageManager().getLaunchIntentForPackage(packageName);
                if (intent == null) continue;
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                return true;
            } catch (Throwable ignored) {}
        }
        return false;
    }

    /**
     * Open a store page for the recommended distributor. The market:// URI is
     * resolved by whichever store app is installed (F-Droid or Play), with the
     * F-Droid web page as a plain-browser fallback.
     */
    static void openDistributorInstallPage(Context context) {
        if (context == null) return;
        Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + NTFY_PACKAGE));
        market.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(market);
            return;
        } catch (Throwable ignored) {}
        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(NTFY_FDROID_URL));
        web.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(web);
        } catch (Throwable ignored) {}
    }

    /** Open the Inboxora notification help page (fixed URL, never caller-supplied). */
    static void openHelpPage(Context context) {
        if (context == null) return;
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(DOCS_URL));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (Throwable ignored) {}
    }
}
