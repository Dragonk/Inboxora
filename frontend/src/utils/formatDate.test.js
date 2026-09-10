import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from './formatDate.js';
const now = new Date(2026, 8, 10, 16, 0);
test('mail dates follow the selected locale including yesterday and local time', () => {
  assert.equal(formatDate(new Date(2026, 8, 10, 13, 5), 'pl', now), '13:05');
  assert.equal(formatDate(new Date(2026, 8, 9), 'pl', now), 'wczoraj');
  assert.equal(formatDate(new Date(2026, 8, 9), 'en', now), 'yesterday');
  assert.match(formatDate(new Date(2026, 8, 1), 'pl', now), /wrz/);
  assert.match(formatDate(new Date(2026, 8, 1), 'en', now), /Sep/);
  assert.match(formatDate(new Date(2025, 8, 1), 'pl', now), /2025/);
});
test('invalid and missing mail dates remain empty', () => {
  assert.equal(formatDate('invalid', 'pl', now), '');
  assert.equal(formatDate(null, 'pl', now), '');
});

test('every shipped language is accepted by Intl, including the zhCN resource ID', () => {
  for (const locale of ['pl', 'en', 'de', 'fr', 'es', 'it', 'cs', 'ru', 'zhCN']) {
    assert.doesNotThrow(() => formatDate(new Date(2026, 8, 9), locale, now));
    assert.doesNotThrow(() => formatDate(new Date(2026, 8, 1), locale, now));
  }
});
