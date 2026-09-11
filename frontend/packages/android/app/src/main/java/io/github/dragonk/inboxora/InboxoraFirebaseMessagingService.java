package io.github.dragonk.inboxora;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * FCM entry point for builds that ship their own Firebase project. The message
 * is data-only and opaque ({ type: "mail.changed", eventId }), so Google never
 * sees a sender, subject, address or body. The notification is built locally
 * after the app fetches the details from its own Inboxora server.
 */
public class InboxoraFirebaseMessagingService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        if (token == null || token.isEmpty()) return;
        InboxoraNativePush.setRegistration(this, InboxoraNativePush.TRANSPORT_FCM, token);
        InboxoraNativePush.enqueueRegistration(this);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        String eventId = message == null ? null : message.getData().get("eventId");
        InboxoraNativePush.enqueueFetch(this, eventId);
    }
}
