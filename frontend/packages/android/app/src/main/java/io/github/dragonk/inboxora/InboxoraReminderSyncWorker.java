package io.github.dragonk.inboxora;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Refreshes the AlarmManager calendar reminder set. Runs on demand (settings
 * change, app start) and periodically, so a moving window of upcoming
 * events stays scheduled.
 */
public class InboxoraReminderSyncWorker extends Worker {
    public InboxoraReminderSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        return InboxoraReminderScheduler.sync(getApplicationContext()) ? Result.success() : Result.retry();
    }
}
