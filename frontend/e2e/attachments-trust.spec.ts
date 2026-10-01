import { test, expect } from './fixtures.ts';
import { attachmentMessage, preview } from './attachment-fixtures.ts';

for (const verified of [true, false]) test(`certificate chain and revocation remain separate (verified=${verified})`, async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['empty-signature.pdf']);
  await page.route('**/api/mail/attachments/process/signatures', route => route.fulfill({ json: {
    status: verified ? 'valid' : 'unknown', trustSource: 'eu-trusted-lists', checkedAt: '2026-10-01T12:00:00Z',
    trustLists: { status: 'ready', lists: [{ territory: 'PL', issuedAt: '2026-10-01T00:00:00Z', nextUpdate: '2026-11-01T00:00:00Z' }] },
    signatures: [{ status: verified ? 'valid' : 'unknown', field: 'Fixture', signer: 'Fixture signer', integrity: 'valid', trust: 'valid', revocation: verified ? 'checked' : 'unknown',
      timestamp: 'absent', diagnostic: verified ? '' : 'REVOCATION_UNAVAILABLE', trustSource: 'eu-trusted-lists',
      chain: [{ subject: 'Fixture signer', issuer: 'Fixture approved CA', fingerprint: 'ab' }, { subject: 'Fixture approved CA', issuer: 'Fixture root', fingerprint: 'cd' }],
    }],
  } }));
  const dialog = await preview(page, 'empty-signature.pdf'); const button = dialog.getByRole('button', { name: 'Signatures', exact: true });
  await expect(button.locator('.attachment-status-dot')).toHaveAttribute('data-status', verified ? 'valid' : 'unknown');
  await button.click(); const details = page.getByTestId('attachment-signature-dialog');
  await expect(details.getByTestId('signature-chain-certificate')).toHaveCount(2);
  await expect(details).toContainText('No cryptographic timestamp is present');
  if (!verified) await expect(details).toContainText('valid CRL/OCSP evidence could not be obtained');
  await details.getByTestId('signature-trust-lists').locator('summary').click();
  await expect(details).toContainText('The loaded lists have valid signatures and are current');
  await expect(details).toContainText('not an automatic import of Adobe AATL');
});

test('an empty signature field does not claim a certificate or trust-list failure', async ({ page, fixtureApi }) => {
  await fixtureApi; await attachmentMessage(page, ['empty-signature.pdf']);
  await page.route('**/api/mail/attachments/process/signatures', route => route.fulfill({ json: {
    status: 'unknown', trustSource: 'eu-trusted-lists', trustLists: { status: 'not-needed', lists: [] },
    signatures: [{ field: 'EmptySignature', page: 1, status: 'unknown', timestamp: 'absent', diagnostic: 'EMPTY_FIELD' }],
  } }));
  const dialog = await preview(page, 'empty-signature.pdf');
  await dialog.getByRole('button', { name: 'Signatures', exact: true }).click();
  const details = page.getByTestId('attachment-signature-dialog');
  await expect(details).toContainText('This is an empty signature field');
  await expect(details).toContainText('No cryptographic timestamp is present');
  await expect(details.getByTestId('signature-trust-lists')).toHaveCount(0);
  await expect(details.locator('.attachment-status-dot[data-status=valid]')).toHaveCount(0);
});
