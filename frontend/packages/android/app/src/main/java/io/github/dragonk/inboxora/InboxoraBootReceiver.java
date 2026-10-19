package io.github.dragonk.inboxora;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * After a reboot both the live WebSocket and every AlarmManager entry are
 * gone. Restart the foreground service and re-sync the reminder window.
 */
public class InboxoraBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        try { InboxoraLivePushService.ensureStarted(context); } catch (Throwable ignored) {}
        try { InboxoraNativePush.enqueueReminderSync(context); } catch (Throwable ignored) {}
    }
}
