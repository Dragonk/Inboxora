import { describe, expect, it } from 'vitest';
import {
  gmailPushConfigured,
  googlePubSubTopic,
  googlePubSubVerificationToken,
  providerPushEnabled,
  publicWebhookBaseUrl,
  publicWebhookUrl,
  renewAheadMinutes,
  syncHintDebounceMs,
  syncHintPollMs,
} from './providerPushConfig.js';

/**
 * The configuration push depends on.
 *
 * The callback URL is derived from the trusted `APP_URL` and never accepted from a request or typed per
 * account, and every unset or unusable value has to mean "push is unavailable, polling carries on" rather
 * than an error: a private installation is a supported one.
 */

describe('the public webhook base', () => {
  it('is off unless the operator turns it on', () => {
    expect(providerPushEnabled({})).toBe(false);
    expect(providerPushEnabled({ PROVIDER_PUSH_ENABLED: 'false' })).toBe(false);
    expect(providerPushEnabled({ PROVIDER_PUSH_ENABLED: 'true' })).toBe(true);
    expect(providerPushEnabled({ PROVIDER_PUSH_ENABLED: '1' })).toBe(true);
  });

  it('derives an https URL from APP_URL and strips a trailing slash', () => {
    expect(publicWebhookBaseUrl({ APP_URL: 'https://mail.example.com/' })).toBe('https://mail.example.com');
    expect(publicWebhookBaseUrl({ APP_URL: 'https://mail.example.com/inboxora/' })).toBe('https://mail.example.com/inboxora');
    expect(publicWebhookUrl('/api/provider-webhooks/microsoft', { APP_URL: 'https://mail.example.com' }))
      .toBe('https://mail.example.com/api/provider-webhooks/microsoft');
  });

  it('refuses plain http outside localhost, because a provider will not deliver to it', () => {
    expect(publicWebhookBaseUrl({ APP_URL: 'http://mail.example.com' })).toBeNull();
    expect(publicWebhookBaseUrl({ APP_URL: 'http://localhost:8080' })).toBe('http://localhost:8080');
    expect(publicWebhookBaseUrl({ APP_URL: 'http://127.0.0.1:8080' })).toBe('http://127.0.0.1:8080');
    expect(publicWebhookBaseUrl({ APP_URL: 'not a url' })).toBeNull();
    expect(publicWebhookBaseUrl({})).toBeNull();
  });
});

describe('the Gmail Pub/Sub configuration', () => {
  it('accepts only a real topic resource name', () => {
    expect(googlePubSubTopic({ GOOGLE_PUBSUB_TOPIC: 'projects/example/topics/inboxora' })).toBe('projects/example/topics/inboxora');
    expect(googlePubSubTopic({ GOOGLE_PUBSUB_TOPIC: 'inboxora' })).toBeNull();
    expect(googlePubSubTopic({ GOOGLE_PUBSUB_TOPIC: 'projects/example' })).toBeNull();
    expect(googlePubSubTopic({})).toBeNull();
  });

  it('requires a high-entropy verification token', () => {
    expect(googlePubSubVerificationToken({ GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'short' })).toBeNull();
    expect(googlePubSubVerificationToken({ GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'a'.repeat(16) })).toBe('a'.repeat(16));
  });

  it('is configured only with push on, a URL, a topic and a token', () => {
    const complete = {
      PROVIDER_PUSH_ENABLED: 'true',
      APP_URL: 'https://mail.example.com',
      GOOGLE_PUBSUB_TOPIC: 'projects/example/topics/inboxora',
      GOOGLE_PUBSUB_VERIFICATION_TOKEN: 'a'.repeat(32),
    };
    expect(gmailPushConfigured(complete)).toBe(true);
    expect(gmailPushConfigured({ ...complete, PROVIDER_PUSH_ENABLED: 'false' })).toBe(false);
    expect(gmailPushConfigured({ ...complete, APP_URL: '' })).toBe(false);
    expect(gmailPushConfigured({ ...complete, GOOGLE_PUBSUB_TOPIC: '' })).toBe(false);
    expect(gmailPushConfigured({ ...complete, GOOGLE_PUBSUB_VERIFICATION_TOKEN: '' })).toBe(false);
  });
});

describe('the timing defaults', () => {
  it('renews ahead of expiry and keeps a sane sweep cadence', () => {
    expect(renewAheadMinutes({})).toBe(30);
    expect(renewAheadMinutes({ PROVIDER_PUSH_RENEW_AHEAD_MINUTES: '0' })).toBe(30);
    expect(renewAheadMinutes({ PROVIDER_PUSH_RENEW_AHEAD_MINUTES: '120' })).toBe(120);
    // Nonsense falls back rather than disabling the sweep.
    expect(renewAheadMinutes({ PROVIDER_PUSH_RENEW_AHEAD_MINUTES: 'abc' })).toBe(30);
  });

  it('coalesces a burst in a short window and drains on a bounded poll', () => {
    expect(syncHintDebounceMs({})).toBe(2000);
    expect(syncHintDebounceMs({ PROVIDER_SYNC_HINT_DEBOUNCE_MS: '0' })).toBe(0);
    expect(syncHintDebounceMs({ PROVIDER_SYNC_HINT_DEBOUNCE_MS: '600000' })).toBe(60_000);
    expect(syncHintPollMs({})).toBe(15_000);
    expect(syncHintPollMs({ PROVIDER_SYNC_HINT_POLL_MS: '1' })).toBe(1000);
    expect(syncHintPollMs({ PROVIDER_SYNC_HINT_POLL_MS: 'nonsense' })).toBe(15_000);
  });
});
