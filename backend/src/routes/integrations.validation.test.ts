import { describe, expect, it } from 'vitest';
import { validateProviderConfig } from './integrations.js';

describe('validateProviderConfig', () => {
  describe('Microsoft configuration', () => {
    it('accepts valid minimal configuration', () => {
      const config = {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        tenantId: 'common',
      };
      const result = validateProviderConfig('microsoft', config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.clientId).toBe('test-client');
        expect(result.config.tenantId).toBe('common');
      }
    });

    it('accepts full configuration', () => {
      const config = {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        tenantId: 'common',
        webEnabled: true,
        deviceEnabled: false,
        enabled: true,
      };
      const result = validateProviderConfig('microsoft', config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.webEnabled).toBe(true);
        expect(result.config.deviceEnabled).toBe(false);
        expect(result.config.disabled).toBe(false);
      }
    });

    it('extracts clearSecret from boolean field', () => {
      const config = {
        clientId: 'test-client',
        clientSecretClear: true,
      };
      const result = validateProviderConfig('microsoft', config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.clearSecret).toBe(true);
      }
    });

    it('rejects google specific fields on microsoft schema', () => {
      const config = {
        clientId: 'test-client',
        apiEnabled: true,
      };
      const result = validateProviderConfig('microsoft', config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Unknown field for microsoft: apiEnabled/);
      }
    });
  });

  describe('Google configuration', () => {
    it('accepts valid minimal configuration', () => {
      const config = {
        clientId: 'test-client',
        clientSecret: 'test-secret',
      };
      const result = validateProviderConfig('google', config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.clientId).toBe('test-client');
      }
    });

    it('accepts full configuration', () => {
      const config = {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://example.com/callback',
        apiEnabled: true,
        enabled: false,
      };
      const result = validateProviderConfig('google', config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.apiEnabled).toBe(true);
        expect(result.config.disabled).toBe(true);
      }
    });

    it('rejects microsoft specific fields on google schema', () => {
      const config = {
        clientId: 'test-client',
        tenantId: 'common',
      };
      const result = validateProviderConfig('google', config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/Unknown field for google: tenantId/);
      }
    });
  });

  describe('Common validation rules', () => {
    it('rejects non-object payload', () => {
      expect(validateProviderConfig('microsoft', null).ok).toBe(false);
      expect(validateProviderConfig('microsoft', undefined).ok).toBe(false);
      expect(validateProviderConfig('microsoft', 'string').ok).toBe(false);
      expect(validateProviderConfig('microsoft', 123).ok).toBe(false);
      expect(validateProviderConfig('microsoft', []).ok).toBe(false);
    });

    it('throws if unknown provider is passed', () => {
      expect(() => validateProviderConfig('yahoo' as any, { clientId: 'test' })).toThrow();
    });

    it('rejects wrong types for string fields', () => {
      const result = validateProviderConfig('microsoft', { clientId: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/clientId must be a string/);
      }
    });

    it('rejects wrong types for boolean fields', () => {
      const result = validateProviderConfig('microsoft', { webEnabled: 'yes' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/webEnabled must be a boolean/);
      }
    });

    it('ignores empty strings for string fields', () => {
      const result = validateProviderConfig('microsoft', {
        clientId: '',
        redirectUri: '',
        tenantId: '',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.clientId).toBeUndefined();
        expect(result.config.redirectUri).toBeUndefined();
        expect(result.config.tenantId).toBeUndefined();
      }
    });

    it('rejects too long strings for non-secret fields', () => {
      const longString = 'a'.repeat(4097);
      const result = validateProviderConfig('microsoft', { clientId: longString });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/clientId is too long/);
      }
    });

    it('rejects too long strings for secret fields', () => {
      const longSecret = 'a'.repeat(8193);
      const result = validateProviderConfig('microsoft', { clientSecret: longSecret });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/clientSecret is too long/);
      }
    });
  });
});
// Just a tiny change to force a commit... EOF
