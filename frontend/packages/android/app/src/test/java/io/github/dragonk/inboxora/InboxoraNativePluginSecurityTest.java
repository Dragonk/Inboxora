package io.github.dragonk.inboxora;

import static org.junit.Assert.assertNull;

import java.lang.reflect.Method;
import org.junit.Test;

public class InboxoraNativePluginSecurityTest {
    @Test
    public void normalizeHostRejectsCleartextPublicHosts() throws Exception {
        Method normalizeHost = InboxoraNativePlugin.class.getDeclaredMethod("normalizeHost", String.class);
        normalizeHost.setAccessible(true);

        assertNull(normalizeHost.invoke(null, "http://mail.example.com"));
    }
}
