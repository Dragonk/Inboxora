import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { providerFailureKey } from './providerFailure.ts';

describe('providerFailureKey', () => {
  it('names the action for a grant that must be authorized again', () => {
    for (const code of ['PROVIDER_AUTH_REQUIRED', 'REAUTH_REQUIRED', 'GRANT_NOT_FOUND', 'TOKEN_REFRESH_FAILED']) {
      assert.equal(providerFailureKey(code), 'providers.syncFailedAuth', code);
    }
  });

  it('separates a missing permission from a lost authorization', () => {
    assert.equal(providerFailureKey('INSUFFICIENT_SCOPES'), 'providers.syncFailedScopes');
  });

  it('says the retry is automatic for a transient failure', () => {
    assert.equal(providerFailureKey('RATE_LIMITED'), 'providers.syncFailedRateLimited');
    assert.equal(providerFailureKey('UPSTREAM_UNAVAILABLE'), 'providers.syncFailedRateLimited');
  });

  it('keeps the raw code when there is no action to name', () => {
    // A fault we do not understand must not be dressed up as a friendly sentence.
    for (const code of ['INTERNAL_ERROR', 'RESOURCE_NOT_FOUND', 'SOMETHING_NEW', '', null, undefined]) {
      assert.equal(providerFailureKey(code), null, String(code));
    }
  });

  it('is case- and whitespace-insensitive, because codes travel through the database', () => {
    assert.equal(providerFailureKey('  insufficient_scopes '), 'providers.syncFailedScopes');
  });
});
