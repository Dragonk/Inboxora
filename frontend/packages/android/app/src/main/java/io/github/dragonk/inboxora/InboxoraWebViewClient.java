package io.github.dragonk.inboxora;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

public class InboxoraWebViewClient extends BridgeWebViewClient {
    private static final String FALLBACK_URL = "file:///android_asset/public/host-unavailable.html";
    private static final String OIDC_PATH_PREFIX = "/auth/oidc/";
    // An SSO round-trip should never take longer than this; the window only widens
    // which navigations stay in the WebView, and is cleared on the first normal
    // Inboxora page after the flow.
    private static final long OIDC_FLOW_TIMEOUT_MS = 10 * 60 * 1000L;

    private final Context context;
    private boolean loadingFallback = false;
    private long oidcFlowStartedAt = 0L;

    public InboxoraWebViewClient(Bridge bridge, Context context) {
        super(bridge);
        this.context = context.getApplicationContext();
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri uri = request == null ? null : request.getUrl();
        if (request == null || uri == null) return super.shouldOverrideUrlLoading(view, request);

        String url = uri.toString();
        boolean oidc = trackOidcFlow(view, url);

        if (isConfiguredHost(url) || FALLBACK_URL.equals(url)) return false;
        // SSO: the identity provider's redirect chain must stay inside this WebView,
        // otherwise the callback sets the session cookie in an external browser and
        // the app itself never logs in.
        if (oidc && isWebUrl(uri)) return false;
        if (!request.isForMainFrame()) return isWebUrl(uri);
        if (openExternallyIfNeeded(url)) return true;

        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, String url) {
        boolean oidc = trackOidcFlow(view, url);

        if (isConfiguredHost(url) || FALLBACK_URL.equals(url)) return false;
        if (oidc && isWebUrl(Uri.parse(url))) return false;
        if (openExternallyIfNeeded(url)) {
            return true;
        }

        return super.shouldOverrideUrlLoading(view, url);
    }

    // True while an OIDC login/logout detour is in progress. The detour starts on
    // an Inboxora /auth/oidc/... page and continues on the identity provider's own
    // domain, so every main-frame navigation in between stays in the WebView.
    private boolean trackOidcFlow(WebView view, String targetUrl) {
        boolean onOidcPage = isOidcPath(targetUrl) || (view != null && isOidcPath(view.getUrl()));
        if (onOidcPage) oidcFlowStartedAt = System.currentTimeMillis();
        return onOidcPage
            || (oidcFlowStartedAt > 0 && System.currentTimeMillis() - oidcFlowStartedAt < OIDC_FLOW_TIMEOUT_MS);
    }

    private boolean isOidcPath(String url) {
        if (url == null || !isConfiguredHost(url)) return false;
        try {
            String path = Uri.parse(url).getPath();
            return path != null && path.startsWith(OIDC_PATH_PREFIX);
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        super.onReceivedHttpError(view, request, errorResponse);

        if (!request.isForMainFrame() || errorResponse == null) return;
        int statusCode = errorResponse.getStatusCode();
        if ((statusCode == 404 || statusCode == 502 || statusCode == 503 || statusCode == 504) && isConfiguredHost(request.getUrl().toString())) {
            loadFallback(view);
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        super.onReceivedError(view, request, error);

        if (request.isForMainFrame() && isConfiguredHost(request.getUrl().toString())) {
            loadFallback(view);
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);

        if (FALLBACK_URL.equals(url)) return;
        loadingFallback = false;

        if (!isConfiguredHost(url)) return;

        // Back on a normal Inboxora page: the SSO detour is over, so external
        // links go to the browser again.
        if (!isOidcPath(url)) oidcFlowStartedAt = 0L;

        InboxoraNativePlugin.injectCapacitorCompat(view);
        InboxoraNativePlugin.injectPendingActions(view, context);

        view.evaluateJavascript("(document.body ? document.body.innerText : '')", (text) -> {
            String bodyText = text == null ? "" : text.toLowerCase();
            if (bodyText.contains("rewrite 502 bad gateway page") || bodyText.contains("rewrite 404 error page")) {
                loadFallback(view);
            }
        });
    }

    private boolean isConfiguredHost(String url) {
        String host = InboxoraNativePlugin.getSavedHost(context);
        return host != null && NativeSecurity.isSameOrigin(host, url);
    }

    private boolean isWebUrl(Uri uri) {
        String scheme = uri == null ? null : uri.getScheme();
        return "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
    }

    private boolean openExternallyIfNeeded(String url) {
        if (url == null || url.trim().isEmpty() || isConfiguredHost(url) || FALLBACK_URL.equals(url)) {
            return false;
        }

        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) {
            return false;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            context.startActivity(intent);
        } catch (ActivityNotFoundException error) {
            return true;
        }

        return true;
    }

    private void loadFallback(WebView view) {
        if (loadingFallback) return;
        loadingFallback = true;
        view.post(() -> view.loadUrl(FALLBACK_URL));
    }
}
