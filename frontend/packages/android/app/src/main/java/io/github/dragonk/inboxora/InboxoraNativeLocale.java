package io.github.dragonk.inboxora;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** App-selected copy is also available to background notifications and launchers. */
final class InboxoraNativeLocale {
    private static final String PREFS = "inboxora-native";
    private static final String LANGUAGE = "language";
    private static final List<String> LANGUAGES = Arrays.asList("en", "pl", "de", "cs", "fr", "es", "it", "ru", "zhCN");
    private static final ExecutorService SHORTCUT_UPDATES = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "Inboxora-shortcuts");
        thread.setDaemon(true);
        return thread;
    });
    private InboxoraNativeLocale() {}

    static Future<?> queueShortcutUpdate(Runnable update) {
        return SHORTCUT_UPDATES.submit(update);
    }

    static String normalize(String language) {
        String tag = language == null ? "en" : language.replace('_', '-').toLowerCase(Locale.ROOT);
        if (tag.startsWith("zh")) return "zhCN";
        String primary = tag.split("-")[0];
        return LANGUAGES.contains(primary) ? primary : "en";
    }

    static String language(Context context) {
        return normalize(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(LANGUAGE, Locale.getDefault().toLanguageTag()));
    }

    static String text(Context context, int resource) {
        Configuration configuration = new Configuration(context.getResources().getConfiguration());
        String language = language(context);
        configuration.setLocale(Locale.forLanguageTag("zhCN".equals(language) ? "zh-CN" : language));
        return context.createConfigurationContext(configuration).getString(resource);
    }

    static String setLanguage(Context context, String value) {
        String language = normalize(value);
        String previous = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LANGUAGE, null);
        if (!language.equals(previous)) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(LANGUAGE, language).apply();
            publishShortcuts(context);
        }
        return language;
    }

    static void publishShortcuts(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        // Keep activity startup responsive and never retain the activity itself.
        // One worker serializes launch, configuration and language updates.
        Context application = context.getApplicationContext();
        queueShortcutUpdate(() -> publishShortcutsOnWorker(application));
    }

    private static void publishShortcutsOnWorker(Context context) {
        // This boundary also protects API 24 if a queued update crosses a configuration change.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        try {
            ShortcutManager manager = context.getSystemService(ShortcutManager.class);
            if (manager == null || manager.isRateLimitingActive()) return;
            String[] routes = { "compose", "calendar", "contacts" };
            int[] labels = { R.string.native_compose, R.string.native_calendar, R.string.native_contacts };
            List<ShortcutInfo> shortcuts = new ArrayList<>();
            for (int rank = 0; rank < routes.length && rank < manager.getMaxShortcutCountPerActivity(); rank++) {
                String route = routes[rank];
                Intent intent = new Intent(context, MainActivity.class)
                    .setAction(Intent.ACTION_VIEW).setData(Uri.parse("inboxora://" + route))
                    .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                shortcuts.add(new ShortcutInfo.Builder(context, "inboxora-" + route)
                    .setShortLabel(text(context, labels[rank])).setLongLabel(text(context, labels[rank]))
                    .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                    .setRank(rank).setIntent(intent).build());
            }
            // Dynamic shortcuts can be relabelled when the app language changes.
            // Original inboxora://compose and inboxora://sync links still resolve.
            if (!manager.setDynamicShortcuts(shortcuts)) Log.w("InboxoraLocale", "Shortcut update was rate limited");
        } catch (IllegalStateException | IllegalArgumentException error) {
            // Launchers may be unavailable until the user unlocks the device.
            // A failed shortcut refresh must never prevent opening the inbox.
            Log.w("InboxoraLocale", "Shortcut refresh unavailable", error);
        }
    }
}
