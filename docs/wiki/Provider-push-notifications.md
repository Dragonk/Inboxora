# Provider push notifications

Inboxora always keeps scheduled polling as a reliability fallback. Provider push
notifications only reduce the delay between a provider-side change and the next
delta/history synchronization.

## Enable provider push

Set:

```env
PROVIDER_PUSH_ENABLED=true
APP_URL=https://mail.example.com
```

`APP_URL` must be publicly reachable over HTTPS.

Polling remains enabled and acts as the safety net if a provider notification is
delayed, expires, or cannot be delivered.

## Microsoft Graph

Microsoft Graph does not require an external message broker.

When provider push is enabled, Inboxora registers Microsoft Graph change
notification subscriptions against:

```text
<APP_URL>/api/provider-webhooks/microsoft
```

Existing native Microsoft mailboxes are bootstrapped automatically after push is
enabled. Inboxora renews Graph subscriptions before they expire.

No Microsoft account reconnect is required merely to enable push for an already
authorized native Graph mailbox.

## Gmail

Gmail push requires Google Cloud Pub/Sub. Use the same Google Cloud project as
the Inboxora Google OAuth client.

The delivery path is:

```text
Gmail
  -> Google Cloud Pub/Sub topic
  -> Pub/Sub push subscription
  -> Inboxora provider webhook
  -> Gmail history synchronization
```

### 1. Enable the required Google Cloud APIs

In the Google Cloud project used by Inboxora, enable:

- Gmail API
- Cloud Pub/Sub API

### 2. Create a Pub/Sub topic

Create a topic such as:

```text
inboxora-gmail-push
```

Its fully qualified name is:

```text
projects/<PROJECT_ID>/topics/inboxora-gmail-push
```

Configure that value as:

```env
GOOGLE_PUBSUB_TOPIC=projects/<PROJECT_ID>/topics/inboxora-gmail-push
```

With `gcloud`:

```bash
gcloud pubsub topics create inboxora-gmail-push \
  --project=<PROJECT_ID>
```

### 3. Grant Gmail permission to publish

Gmail publishes notifications through this Google-managed service account:

```text
gmail-api-push@system.gserviceaccount.com
```

Grant it the **Pub/Sub Publisher** role on the topic.

With `gcloud`:

```bash
gcloud pubsub topics add-iam-policy-binding inboxora-gmail-push \
  --project=<PROJECT_ID> \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

### 4. Generate Inboxora's webhook verification token

Generate a high-entropy secret yourself:

```bash
openssl rand -base64 32
```

Store the generated value in Inboxora:

```env
GOOGLE_PUBSUB_VERIFICATION_TOKEN=<GENERATED_TOKEN>
```

This secret authenticates Pub/Sub requests sent to Inboxora. It is not supplied
by Google.

### 5. Create a Pub/Sub push subscription

Create a push subscription for the topic and point it at:

```text
<APP_URL>/api/provider-webhooks/gmail?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>
```

For example:

```bash
gcloud pubsub subscriptions create inboxora-gmail-push \
  --project=<PROJECT_ID> \
  --topic=inboxora-gmail-push \
  --push-endpoint="https://mail.example.com/api/provider-webhooks/gmail?token=<GENERATED_TOKEN>"
```

When using the Google Cloud Console, choose:

- Pub/Sub -> Subscriptions -> Create subscription
- Topic: `inboxora-gmail-push`
- Delivery type: `Push`
- Endpoint:
  `<APP_URL>/api/provider-webhooks/gmail?token=<GENERATED_TOKEN>`

### 6. Configure Inboxora

The backend environment must contain:

```env
PROVIDER_PUSH_ENABLED=true
GOOGLE_PUBSUB_TOPIC=projects/<PROJECT_ID>/topics/inboxora-gmail-push
GOOGLE_PUBSUB_VERIFICATION_TOKEN=<GENERATED_TOKEN>
```

For Docker Compose this can be exposed as:

```yaml
environment:
  PROVIDER_PUSH_ENABLED: "true"
  GOOGLE_PUBSUB_TOPIC: ${GOOGLE_PUBSUB_TOPIC:-}
  GOOGLE_PUBSUB_VERIFICATION_TOKEN: ${GOOGLE_PUBSUB_VERIFICATION_TOKEN:-}
```

Restart the backend after changing these values.

When all required Pub/Sub settings are present, Inboxora registers Gmail
`users.watch` for existing Gmail-native mailboxes. The watch is renewed before
expiry, while scheduled polling remains active as a fallback.

### 7. Verify Gmail push

After startup, inspect the provider subscriptions table. A working Gmail watch
appears as a Google `mail` subscription with an active status.

Receiving a Gmail notification updates `last_notification_at` and queues a
provider synchronization hint.

If no Gmail subscription appears, first verify:

- `PROVIDER_PUSH_ENABLED=true`
- `GOOGLE_PUBSUB_TOPIC` is present and uses the full
  `projects/<PROJECT_ID>/topics/<TOPIC>` form
- `GOOGLE_PUBSUB_VERIFICATION_TOKEN` is set
- the Gmail API and Pub/Sub API are enabled
- `gmail-api-push@system.gserviceaccount.com` has Publisher access to the topic
- the Pub/Sub push subscription points at the public Inboxora HTTPS URL

## Google Calendar

Google Calendar push uses provider push channels directly and does not use the
Gmail Pub/Sub topic. Inboxora manages one channel per enabled provider calendar.

## Google Contacts

Google People contacts do not use the Gmail Pub/Sub watch. Contact
synchronization remains polling-based.
