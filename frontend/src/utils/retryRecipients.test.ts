import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionRejectedRecipients } from './retryRecipients.ts';

test('partial delivery retries retain recipients in their original header roles', () => {
  const retry = partitionRejectedRecipients(
    ['to@example.test', 'cc@example.test', 'SECRET@example.test'],
    {
      to: ['To Person <to@example.test>'],
      cc: ['CC Person <cc@example.test>'],
      bcc: ['Secret Person <secret@example.test>'],
    },
  );

  assert.deepEqual(retry, {
    to: ['To Person <to@example.test>'],
    cc: ['CC Person <cc@example.test>'],
    bcc: ['Secret Person <secret@example.test>'],
  });
});

test('a BCC-only retry never moves hidden recipients into To', () => {
  const retry = partitionRejectedRecipients(
    ['secret-one@example.test', 'secret-two@example.test'],
    {
      to: ['accepted@example.test'],
      cc: [],
      bcc: ['Secret One <secret-one@example.test>', 'secret-two@example.test'],
    },
  );

  assert.deepEqual(retry.to, []);
  assert.deepEqual(retry.cc, []);
  assert.deepEqual(retry.bcc, ['Secret One <secret-one@example.test>', 'secret-two@example.test']);
});
