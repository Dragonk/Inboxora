package io.github.dragonk.inboxora;

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Full-screen calendar alarm, launched by the reminder's full-screen intent
 * (and usable directly on the lock screen). One tap stops the ringing; the
 * notification itself is cancelled so the insistent sound cannot continue
 * behind the dismissed activity.
 */
public class InboxoraAlarmActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Show over the lock screen, with the screen on, like the stock alarm.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            Window window = getWindow();
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }

        int notificationId = getIntent().getIntExtra("notificationId", -1);
        String summary = getIntent().getStringExtra("summary");
        String description = getIntent().getStringExtra("describe");

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(32), dp(48), dp(32), dp(32));

        TextView title = new TextView(this);
        title.setText(InboxoraNativeLocale.text(this, R.string.native_calendar_alarm_title));
        title.setTextSize(20);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        TextView summaryView = new TextView(this);
        summaryView.setText(summary == null || summary.isEmpty()
            ? InboxoraNativeLocale.text(this, R.string.native_calendar_reminder_title)
            : summary);
        summaryView.setTextSize(28);
        summaryView.setPadding(0, dp(16), 0, 0);
        summaryView.setGravity(Gravity.CENTER);
        root.addView(summaryView);

        TextView detail = new TextView(this);
        detail.setText(description == null ? "" : description);
        detail.setTextSize(16);
        detail.setPadding(0, dp(8), 0, dp(32));
        detail.setGravity(Gravity.CENTER);
        root.addView(detail);

        Button stop = new Button(this);
        stop.setText(InboxoraNativeLocale.text(this, R.string.native_calendar_alarm_stop));
        stop.setOnClickListener((View view) -> {
            cancelNotification(notificationId);
            finish();
        });
        root.addView(stop);

        Button open = new Button(this);
        open.setText(InboxoraNativeLocale.text(this, R.string.native_calendar));
        open.setOnClickListener((View view) -> {
            cancelNotification(notificationId);
            Intent intent = new Intent(this, MainActivity.class);
            intent.setAction(Intent.ACTION_VIEW);
            intent.setData(Uri.parse("inboxora://calendar"));
            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(intent);
            finish();
        });
        root.addView(open);

        setContentView(root);
    }

    private void cancelNotification(int notificationId) {
        if (notificationId == -1) return;
        try {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.cancel(notificationId);
        } catch (Exception ignored) {}
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
