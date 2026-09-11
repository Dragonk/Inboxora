import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowPrivatePushEndpoints, pushBaseUrl } from './pushConfig.js';

afterEach(() => vi.unstubAllEnvs());

describe('pushBaseUrl', () => {
  it('defaults to the APP_URL plus /push', () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('PUSH_BASE_URL', '');
    expect(pushBaseUrl()).toBe('https://mail.example.com/push');
  });

  it('normalizes trailing slashes', () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com/');
    vi.stubEnv('PUSH_BASE_URL', '');
    expect(pushBaseUrl()).toBe('https://mail.example.com/push');
  });

  it('prefers an explicit external PUSH_BASE_URL', () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('PUSH_BASE_URL', 'https://push.example.net/');
    expect(pushBaseUrl()).toBe('https://push.example.net');
  });

  it('returns null when neither is configured', () => {
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('PUSH_BASE_URL', '');
    expect(pushBaseUrl()).toBeNull();
  });
});

describe('allowPrivatePushEndpoints', () => {
  it('is off unless explicitly enabled', () => {
    vi.stubEnv('PUSH_ALLOW_PRIVATE_ENDPOINTS', '');
    expect(allowPrivatePushEndpoints()).toBe(false);
    vi.stubEnv('PUSH_ALLOW_PRIVATE_ENDPOINTS', 'true');
    expect(allowPrivatePushEndpoints()).toBe(true);
  });
});
