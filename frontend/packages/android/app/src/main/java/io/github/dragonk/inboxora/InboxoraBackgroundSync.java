package io.github.dragonk.inboxora;

import android.content.Context;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public final class InboxoraBackgroundSync {
    private static final String PERIODIC_WORK = "inboxora-background-mail-check";
    private static final String ONE_TIME_WORK = "inboxora-background-mail-check-once";

    private InboxoraBackgroundSync() {}

    public static void schedule(Context context) {
        if (context == null || InboxoraNativePlugin.getSavedHost(context) == null) return;

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        PeriodicWorkRequest periodicRequest = new PeriodicWorkRequest.Builder(
            InboxoraBackgroundWorker.class,
            15,
            TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .build();

        OneTimeWorkRequest oneTimeRequest = new OneTimeWorkRequest.Builder(InboxoraBackgroundWorker.class)
            .setInitialDelay(45, TimeUnit.SECONDS)
            .setConstraints(constraints)
            .build();

        WorkManager workManager = WorkManager.getInstance(context.getApplicationContext());
        workManager.enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, periodicRequest);
        workManager.enqueueUniqueWork(ONE_TIME_WORK, ExistingWorkPolicy.REPLACE, oneTimeRequest);
    }
}
