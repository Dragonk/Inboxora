import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowPrivatePushEndpoints, pushBaseUrl } from './pushConfig.js';

afterEach(() => vi.unstubAllEnvs());

describe('pushBaseUrl', () => {
  // The ntfy Android distributor rejects base URLs containing a path, so the
  // advertised base is the origin; nginx routes the "up<12>" topics to ntfy.
  it('defaults to the APP_URL origin (no /push path)', () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com');
    vi.stubEnv('PUSH_BASE_URL', '');
    expect(pushBaseUrl()).toBe('https://mail.example.com');
  });

  it('normalizes trailing slashes', () => {
    vi.stubEnv('APP_URL', 'https://mail.example.com/');
    vi.stubEnv('PUSH_BASE_URL', '');
    expect(pushBaseUrl()).toBe('https://mail.example.com');
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
