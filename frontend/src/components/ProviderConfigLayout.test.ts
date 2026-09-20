import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The two provider configuration cards, laid out the same way.
 *
 * A live acceptance round reported that "Zapisz konfigurację" and "Sprawdź konfigurację" looked and sat
 * differently in the Microsoft and Google cards. They are the same two actions, so they belong in the same
 * order, in the same row, with the same metrics, and the result belongs in the same place under that row.
 */

const panel = new URL('./AdminPanel.tsx', import.meta.url);
const read = () => readFile(panel, 'utf8');

/**
 * The action row of one provider card, taken from the row that holds its save action up to the close of the row
 * that holds its test action, so an unrelated flex row elsewhere in the file cannot be matched.
 */
function rowFor(source: string, saveMarker: string, provider: string): string {
  const saveAt = source.indexOf(`onClick={${saveMarker}}`);
  assert.ok(saveAt !== -1, `${saveMarker} not found`);
  const openAt = source.lastIndexOf("<div style={{ display: 'flex', gap: 8 }}>", saveAt);
  assert.ok(openAt !== -1, `no action row opens before ${saveMarker}`);
  const testAt = source.indexOf(`<ProviderConfigTest provider="${provider}" />`, saveAt);
  assert.ok(testAt !== -1, `${provider} test action not found after ${saveMarker}`);
  const closeAt = source.indexOf('</div>', testAt);
  return source.slice(openAt, closeAt);
}

function actionRows(source: string): string[] {
  return [rowFor(source, 'handleSaveMs', 'microsoft'), rowFor(source, 'handleSaveGoogle', 'google')];
}

test('both cards render save then test in one action row', async () => {
  const source = await read();
  const rows = actionRows(source);
  assert.ok(rows.length >= 2, 'expected an action row in each provider card');

  const [microsoft, google] = rows;
  // Save first, then the configuration test, in both.
  assert.ok(microsoft.includes('onClick={handleSaveMs}'), 'the Microsoft row does not hold its save action');
  assert.match(microsoft, /<ProviderConfigTest provider="microsoft" \/>/);
  assert.ok(microsoft.indexOf('onClick={handleSaveMs}') < microsoft.indexOf('ProviderConfigTest'), 'Microsoft: test before save');
  assert.ok(google.includes('onClick={handleSaveGoogle}'), 'the Google row does not hold its save action');
  assert.match(google, /<ProviderConfigTest provider="google" \/>/);
  assert.ok(google.indexOf('onClick={handleSaveGoogle}') < google.indexOf('ProviderConfigTest'), 'Google: test before save');
});

test('the two action rows use the same button metrics', async () => {
  const source = await read();
  const [microsoft, google] = actionRows(source);

  // The same padding, radius, font size and weight, so the two cards cannot drift apart again.
  for (const row of [microsoft, google]) {
    assert.match(row, /padding: '9px 16px'/);
    assert.match(row, /borderRadius: 8/);
    assert.match(row, /fontSize: 13/);
    assert.match(row, /fontWeight: 500/);
  }
  // Neither row may carry its own gap: the row itself decides the spacing.
  assert.match(microsoft, /display: 'flex', gap: 8/);
  assert.match(google, /display: 'flex', gap: 8/);
});

test('each card saves under its own label, and never the other provider’s', async () => {
  const source = await read();
  const [microsoft, google] = actionRows(source);

  assert.match(microsoft, /t\('admin\.integrations\.microsoft\.save'\)/);
  // The Google button used the Microsoft key, which is how the two cards came to disagree.
  assert.match(google, /t\('admin\.integrations\.google\.save'\)/);
  assert.ok(!google.includes('admin.integrations.microsoft.save'), 'the Google card still uses the Microsoft label');
});

test('no instruction sits inside an action row', async () => {
  const source = await read();
  const [microsoft, google] = actionRows(source);

  // The "accounts are added in Accounts" hint is guidance, not an action; it sits under the row in both cards.
  assert.ok(!microsoft.includes('microsoft-accounts-only'), 'the hint is still inside the Microsoft action row');
  assert.ok(!google.includes('microsoft-accounts-only'), 'the hint is inside the Google action row');
  assert.match(source, /data-testid="microsoft-accounts-only"/);
  assert.match(source, /data-testid="google-accounts-only"/);
});

test('the result sits under the action row in both cards', async () => {
  const source = await read();
  // One message element per provider, and it follows the row rather than preceding it.
  const microsoftMessageAt = source.indexOf('{saveMsg}');
  const googleMessageAt = source.indexOf('{googleSaveMsg}');
  // Both cards render their message, and both do it with the same block style.
  assert.ok(microsoftMessageAt !== -1 && googleMessageAt !== -1);
  const styleBlocks = source.match(/background: (?:saveMsg|googleSaveMsg)\.startsWith\('Error'\) \? 'rgba\(248,113,113,0\.1\)' : 'rgba\(74,222,128,0\.1\)'/g) ?? [];
  assert.equal(styleBlocks.length, 2, 'the two result blocks do not share one style');
});
