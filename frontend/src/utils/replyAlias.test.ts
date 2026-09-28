import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectOwnAddresses, parseAddressListField, pickReplyAlias } from './replyAlias.ts';

const aliases = [
  { id: 'alias-1', email: 'sales@example.com' },
  { id: 'alias-2', email: 'support@example.com' },
];

describe('parseAddressListField', () => {
  it('returns arrays as-is', () => {
    const arr = [{ email: 'a@example.com' }];
    assert.equal(parseAddressListField(arr), arr);
  });

  it('parses a JSON string', () => {
    assert.deepEqual(parseAddressListField('[{"email":"a@example.com"}]'), [{ email: 'a@example.com' }]);
  });

  it('is null-safe for malformed JSON', () => {
    assert.deepEqual(parseAddressListField('not json'), []);
  });

  it('defaults missing input to []', () => {
    assert.deepEqual(parseAddressListField(undefined), []);
    assert.deepEqual(parseAddressListField(null), []);
  });
});

describe('pickReplyAlias', () => {
  it('matches a delivery address not present in To/Cc (BCC / catch-all case)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'someone-else@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('matches To when there is no delivery address hit (unchanged semantics)', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('matches Cc when there is no delivery or To hit', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('falls back to from_email when nothing else matches', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: 'support@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('prefers the delivery address match over a different To/Cc match', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-1');
  });

  it('returns null when the account has no aliases', () => {
    const result = pickReplyAlias({
      aliases: [],
      deliveryAddresses: ['sales@example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('is null-safe against malformed JSON strings', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: 'not json',
      toAddresses: 'not json',
      ccAddresses: 'not json',
      fromEmail: '',
    });
    assert.equal(result, null);
  });

  it('matches case-insensitively', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['SALES@Example.com'],
      toAddresses: [],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-1');
  });

  it('prefers To over Cc regardless of alias creation order', () => {
    // The contacted To identity is more specific than a Cc alias.
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [{ email: 'support@example.com' }],
      ccAddresses: [{ email: 'sales@example.com' }],
      fromEmail: 'them@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('prefers a recipient identity over the outgoing From fallback', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: [],
      toAddresses: [],
      ccAddresses: [{ email: 'support@example.com' }],
      fromEmail: 'sales@example.com',
    });
    assert.equal(result, 'alias-2');
  });

  it('lets a delivery match beat alias creation order', () => {
    const result = pickReplyAlias({
      aliases,
      deliveryAddresses: ['support@example.com'],
      toAddresses: [{ email: 'sales@example.com' }],
      ccAddresses: [],
      fromEmail: '',
    });
    assert.equal(result, 'alias-2');
  });
});


describe('reply identity priority and defensive address parsing (#9)', () => {
  it('uses a contacted To alias even when final delivery names the primary mailbox', () => {
    assert.equal(pickReplyAlias({ aliases, accountEmail: 'main@example.com', deliveryAddresses: ['main@example.com'], toAddresses: [{ email: 'sales@example.com' }] }), 'alias-1');
  });
  it('keeps an original delivery alias when metadata also contains the final primary mailbox', () => {
    assert.equal(pickReplyAlias({ aliases, accountEmail: 'main@example.com', deliveryAddresses: ['main@example.com', 'support@example.com'] }), 'alias-2');
  });
  it('stops at a primary To match instead of choosing a Cc alias', () => {
    assert.equal(pickReplyAlias({ aliases, accountEmail: 'main@example.com', toAddresses: [{ email: 'main@example.com' }], ccAddresses: [{ email: 'sales@example.com' }] }), null);
  });
  it('uses ordered delivery recipients, not alias creation order', () => {
    assert.equal(pickReplyAlias({ aliases, deliveryAddresses: ['support@example.com', 'sales@example.com'] }), 'alias-2');
  });
  it('normalizes strings, parsed address objects, case and whitespace', () => {
    assert.equal(pickReplyAlias({ aliases, deliveryAddresses: [{ address: ' Support <SUPPORT@example.com> ' }] }), 'alias-2');
    assert.equal(pickReplyAlias({ aliases, toAddresses: ['SALES@example.com'] }), 'alias-1');
  });
  it('does not crash on scalar JSON, null entries or malformed address objects', () => {
    for (const value of ['null', '123', '{}', '"email@example.com"']) {
      assert.deepEqual(parseAddressListField(value), []);
      assert.equal(pickReplyAlias({ aliases, deliveryAddresses: value, toAddresses: value, ccAddresses: value }), null);
    }
    assert.equal(pickReplyAlias({ aliases, deliveryAddresses: [null, 5, {}, { email: 7 }] }), null);
  });
  it('never promotes an unconfigured delivery address to a sender', () => {
    assert.equal(pickReplyAlias({ aliases, accountEmail: 'main@example.com', deliveryAddresses: ['unconfigured@example.com'] }), null);
  });
});


describe('normalized email/address fallback (CodeRabbit #21)', () => {
  for (const email of [undefined, null, '', '  ', 'not-an-email', 'Label < >']) {
    it(`falls back to address when email is ${JSON.stringify(email)}, consistently for sender and own identities`, () => {
      const entry = { email, address: ' Support <SUPPORT@example.com> ' };
      for (const deliveryAddresses of [[entry], JSON.stringify([entry])]) {
        assert.equal(pickReplyAlias({ aliases, deliveryAddresses }), 'alias-2');
        assert.deepEqual([...collectOwnAddresses({ message: { delivery_addresses: deliveryAddresses } })], ['support@example.com']);
      }
      assert.equal(pickReplyAlias({ aliases, toAddresses: [entry] }), 'alias-2');
      assert.equal(pickReplyAlias({ aliases, ccAddresses: [entry] }), 'alias-2');
    });
  }
  it('keeps a valid normalized email ahead of a conflicting address', () => {
    const entry = { email: ' Sales <SALES@example.com> ', address: 'support@example.com' };
    assert.equal(pickReplyAlias({ aliases, deliveryAddresses: [entry] }), 'alias-1');
    assert.deepEqual([...collectOwnAddresses({ message: { delivery_addresses: [entry] } })], ['sales@example.com']);
  });
});
