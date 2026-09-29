package io.github.dragonk.inboxora;

import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

import java.lang.reflect.Method;
import org.junit.Test;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

public class InboxoraNativePluginSecurityTest {
    @Test
    public void repeatedLauncherNavigationDoesNotWeakenNotificationReplayProtection() {
        for (String route : new String[] { "compose", "calendar", "contacts", "sync", "CONTACTS" }) {
            assertTrue(InboxoraNativePlugin.isRepeatableLaunch("android.intent.action.VIEW", "inboxora", route));
        }
        assertTrue(InboxoraNativePlugin.isRepeatableLaunch(InboxoraNativePlugin.ACTION_COMPOSE, null, null));
        assertTrue(InboxoraNativePlugin.isRepeatableLaunch(InboxoraNativePlugin.ACTION_SYNC, null, null));
        assertTrue(InboxoraNativePlugin.isRepeatableLaunch("android.intent.action.SENDTO", "mailto", null));
        for (String action : new String[] { InboxoraNativePlugin.ACTION_DELETE_MESSAGE, InboxoraNativePlugin.ACTION_STAR_MESSAGE,
                InboxoraNativePlugin.ACTION_REPLY_MESSAGE, InboxoraNativePlugin.ACTION_OPEN_MESSAGE, InboxoraNativePlugin.ACTION_INSTALL_UPDATE, null }) {
            assertFalse(InboxoraNativePlugin.isRepeatableLaunch(action, "inboxora", "compose"));
        }
        assertFalse(InboxoraNativePlugin.isRepeatableLaunch("android.intent.action.VIEW", "inboxora", "delete"));
        assertFalse(InboxoraNativePlugin.isRepeatableLaunch("android.intent.action.VIEW", "https", "calendar"));
    }

    @Test
    public void nativeLocaleSupportsEveryAppLanguageAndFallsBackSafely() {
        for (String language : new String[] { "en", "pl", "de", "cs", "es", "fr", "it", "ru", "zhCN" }) {
            assertEquals(language, InboxoraNativeLocale.normalize(language));
        }
        assertEquals("pl", InboxoraNativeLocale.normalize("pl-PL"));
        assertEquals("de", InboxoraNativeLocale.normalize("de_DE"));
        assertEquals("zhCN", InboxoraNativeLocale.normalize("zh-CN"));
        assertEquals("en", InboxoraNativeLocale.normalize("pt-BR"));
        assertEquals("en", InboxoraNativeLocale.normalize(null));
    }

    @Test
    public void shortcutUpdatesRunOffTheCallerThreadAndInSubmissionOrder() throws Exception {
        Thread caller = Thread.currentThread();
        List<Integer> order = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch release = new CountDownLatch(1);
        Future<?> first = InboxoraNativeLocale.queueShortcutUpdate(() -> {
            assertFalse(Thread.currentThread() == caller);
            try { assertTrue(release.await(5, TimeUnit.SECONDS)); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
            order.add(1);
        });
        Future<?> second = InboxoraNativeLocale.queueShortcutUpdate(() -> order.add(2));
        assertTrue(order.isEmpty());
        release.countDown();
        first.get(5, TimeUnit.SECONDS); second.get(5, TimeUnit.SECONDS);
        assertEquals(java.util.Arrays.asList(1, 2), order);
    }

    @Test
    public void normalizeHostRejectsCleartextPublicHosts() throws Exception {
        Method normalizeHost = InboxoraNativePlugin.class.getDeclaredMethod("normalizeHost", String.class);
        normalizeHost.setAccessible(true);

        assertNull(normalizeHost.invoke(null, "http://mail.example.com"));
    }
}
