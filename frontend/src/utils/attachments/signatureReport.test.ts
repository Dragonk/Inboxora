import test from 'node:test';
import assert from 'node:assert/strict';
import { signatureReport } from './signatureReport.ts';

test('path trust without revocation never turns the overall badge green', () => {
  const report = signatureReport({ status: 'valid', signatures: [{ status: 'valid', integrity: 'valid', trust: 'valid', revocation: 'unknown', timestamp: 'absent', chain: [{ subject: 'Known CA' }] }] });
  assert.equal(report.status, 'unknown'); assert.equal(report.signatures[0].status, 'unknown');
  assert.equal(report.signatures[0].fields.trust, 'valid'); assert.equal(report.signatures[0].fields.timestamp, 'absent');
});
test('certificate paths and trust-list information are bounded inert text', () => {
  const report = signatureReport({ status: 'valid', trustLists: { status: 'ready', lists: [{ territory: 'PL', issuedAt: '2026-10-01T00:00:00Z', nextUpdate: '2026-10-02T00:00:00Z' }] }, signatures: [{
    status: 'valid', integrity: 'valid', trust: 'valid', revocation: 'checked', timestamp: 'absent', trustSource: 'eu-trusted-lists',
    chain: [{ subject: '<script>document.cookie</script>', issuer: 'x'.repeat(3000) }],
  }] });
  assert.equal(report.status, 'valid'); assert.equal(report.signatures[0].chain[0].subject, '<script>document.cookie</script>');
  assert.equal(report.signatures[0].chain[0].issuer.length, 2048); assert.equal(report.lists[0].country, 'PL');
  assert.throws(() => signatureReport({ signatures: [{ chain: Array(13).fill({}) }] }), /CORRUPT/);
});
