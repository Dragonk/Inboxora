package io.github.dragonk.inboxora;

import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.data.PushEndpoint;
import org.unifiedpush.android.connector.data.PushMessage;

/**
 * UnifiedPush entry point. The distributor wakes this service when the user's
 * distributor has a new endpoint or delivers a message. Both handlers only
 * persist state / enqueue WorkManager work — no network or notification work
 * happens on the service thread.
 */
public class InboxoraPushService extends PushService {
    @Override
    public void onNewEndpoint(PushEndpoint endpoint, String instance) {
        if (endpoint == null || endpoint.getUrl() == null) return;
        InboxoraNativePush.setRegistration(this, InboxoraNativePush.TRANSPORT_UNIFIEDPUSH, endpoint.getUrl());
        InboxoraNativePush.enqueueRegistration(this);
    }

    @Override
    public void onMessage(PushMessage message, String instance) {
        String eventId = message == null ? null : InboxoraNativePush.parseEventId(message.getContent());
        InboxoraNativePush.enqueueFetch(this, eventId);
    }

    @Override
    public void onRegistrationFailed(FailedReason reason, String instance) {
        InboxoraNativePush.setStatus(this, InboxoraNativePush.STATUS_UNAVAILABLE);
    }

    @Override
    public void onUnregistered(String instance) {
        // The distributor dropped us (revoked/uninstalled). Forget the endpoint so
        // no server-side registration survives, and let the reconciler keep mail fresh.
        InboxoraNativePush.clearRegistration(this);
    }
}
