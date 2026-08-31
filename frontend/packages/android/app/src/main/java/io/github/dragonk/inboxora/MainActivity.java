package io.github.dragonk.inboxora;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private String lastHandledIntentKey = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(InboxoraNativePlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                handleAndroidBack();
            }
        });

        if (bridge != null) {
            configureCookies();
            bridge.setWebViewClient(new InboxoraWebViewClient(bridge, this));
            String savedHost = InboxoraNativePlugin.getSavedHost(this);
            configureNativeMessageBridge(savedHost);
            if (savedHost != null) {
                InboxoraBackgroundSync.schedule(this);
                bridge.getWebView().post(() -> bridge.getWebView().loadUrl(savedHost));
            }
        }

        handleNativeIntent(getIntent());
    }

    @Override
    public void onPause() {
        flushCookies();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        InboxoraNativePlugin.resumePendingUpdateInstall();
    }

    @Override
    public void onStop() {
        flushCookies();
        InboxoraBackgroundSync.schedule(this);
        super.onStop();
    }

    @Override
    public void onDestroy() {
        flushCookies();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNativeIntent(intent);
    }

    private void handleAndroidBack() {
        if (bridge == null || bridge.getWebView() == null) {
            moveTaskToBack(true);
            return;
        }

        WebView webView = bridge.getWebView();
        webView.evaluateJavascript(
            "(function(){try{"
                + "if(typeof window.__inboxoraHandleAndroidBack==='function'){return !!window.__inboxoraHandleAndroidBack();}"
                + "}catch(e){}"
                + "return false;"
                + "})()",
            (handled) -> {
                if ("true".equals(handled)) return;

                runOnUiThread(() -> moveTaskToBack(true));
            }
        );
    }

    private void handleNativeIntent(Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        Uri data = intent.getData();
        if (InboxoraNativePlugin.isPrivilegedNativeAction(action)
            && !InboxoraNativePlugin.isTrustedNativeIntent(this, intent)) return;
        if (!markIntentHandled(intent)) return;

        if (InboxoraNativePlugin.ACTION_OPEN_MESSAGE.equals(action)) {
            InboxoraNativePlugin.sendOpenMessageAction(intent);
            return;
        }

        if (InboxoraNativePlugin.ACTION_REPLY_MESSAGE.equals(action)) {
            InboxoraNativePlugin.sendReplyMessageAction(intent);
            return;
        }

        if (InboxoraNativePlugin.ACTION_DELETE_MESSAGE.equals(action)) {
            InboxoraNativePlugin.sendDeleteMessageAction(intent);
            return;
        }

        if (InboxoraNativePlugin.ACTION_STAR_MESSAGE.equals(action)) {
            InboxoraNativePlugin.sendStarMessageAction(intent);
            return;
        }

        if (InboxoraNativePlugin.ACTION_COMPOSE.equals(action)) {
            InboxoraNativePlugin.sendComposeAction();
            return;
        }

        if (InboxoraNativePlugin.ACTION_SYNC.equals(action)) {
            InboxoraNativePlugin.sendSyncAction();
            return;
        }

        if (InboxoraNativePlugin.ACTION_INSTALL_UPDATE.equals(action)) {
            InboxoraNativePlugin.installDownloadedUpdateFromIntent();
            return;
        }

        if (Intent.ACTION_VIEW.equals(action) && data != null && "inboxora".equalsIgnoreCase(data.getScheme())) {
            String route = data.getHost();
            if (route == null || route.isEmpty()) {
                route = data.getPath() == null ? "" : data.getPath().replaceFirst("^/", "");
            }

            if ("compose".equalsIgnoreCase(route)) {
                InboxoraNativePlugin.sendComposeAction();
                return;
            }

            if ("sync".equalsIgnoreCase(route)) {
                InboxoraNativePlugin.sendSyncAction();
                return;
            }
        }

        if ((Intent.ACTION_SENDTO.equals(action) || Intent.ACTION_VIEW.equals(action)) && data != null && "mailto".equalsIgnoreCase(data.getScheme())) {
            InboxoraNativePlugin.sendMailtoAction(data);
        }
    }

    private boolean markIntentHandled(Intent intent) {
        String action = intent.getAction();
        Uri data = intent.getData();
        String messageId = intent.getStringExtra("messageId");
        String key = String.valueOf(action) + "|" + String.valueOf(data) + "|" + String.valueOf(messageId);

        if (key.equals(lastHandledIntentKey)) return false;
        lastHandledIntentKey = key;
        return true;
    }

    private void configureCookies() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && bridge != null && bridge.getWebView() != null) {
            cookieManager.setAcceptThirdPartyCookies(bridge.getWebView(), false);
        }
    }

    void configureNativeMessageBridge(String configuredHost) {
        if (bridge == null || bridge.getWebView() == null) return;
        InboxoraNativeMessageBridge.configure(bridge.getWebView(), this, configuredHost);
    }

    private void flushCookies() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().flush();
        }
    }
}
