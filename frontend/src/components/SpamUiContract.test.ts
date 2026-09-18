import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

function mustContain(source: string, needle: string, label: string): void {
  assert.ok(source.includes(needle), `expected ${label} to contain ${needle}`);
}

describe('spam UI contract', () => {
  it('exposes badge, explain dialog test id and settings hooks', () => {
    const badge = readFileSync(new URL('./SpamBadge.tsx', import.meta.url), 'utf8');
    mustContain(badge, 'data-spam-badge', 'SpamBadge');
    mustContain(badge, 'spam-explain-dialog', 'SpamBadge');
    mustContain(badge, 'spamApi.explain(messageId)', 'SpamBadge');
    const settings = readFileSync(new URL('./SpamSettings.tsx', import.meta.url), 'utf8');
    mustContain(settings, 'data-spam-settings', 'SpamSettings');
    mustContain(settings, 'data-testid="spam-master-toggle"', 'SpamSettings');
    mustContain(settings, 'data-testid="spam-retrain-now"', 'SpamSettings');
    mustContain(settings, 'data-testid="spam-maturity"', 'SpamSettings');
  });

  it('mounts SpamSettings under Settings → Rules → Antispam', () => {
    const admin = readFileSync(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
    mustContain(admin, "import SpamSettings from './SpamSettings.tsx'", 'AdminPanel import');
    mustContain(admin, "id: 'antispam'", 'Rules antispam sub-tab');
    mustContain(admin, 'subTabAntispam', 'Rules antispam label');
    mustContain(admin, '<SpamSettings />', 'SpamSettings mount');
  });

  it('registers every new locale key in all locales', () => {
    const keys = [
      'badgeSpam', 'badgeUnsure', 'explainTitle', 'explainMethod',
      'settingsTitle', 'maturity', 'enable', 'disable', 'retrainNow',
      'enableAccount', 'enableAccountDesc', 'trustedAuthservId', 'trustedAuthservIdDesc',
    ];
    for (const locale of ['en', 'de', 'fr', 'es', 'it', 'ru', 'zhCN', 'pl', 'cs']) {
      const data = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')) as {
        spam?: Record<string, unknown>;
        admin?: { rules?: Record<string, unknown> };
      };
      for (const key of keys) {
        assert.equal(typeof data.spam?.[key], 'string', `missing spam.${key} in ${locale}`);
        assert.ok(String(data.spam?.[key]).length > 0, `empty spam.${key} in ${locale}`);
      }
      assert.equal(typeof data.admin?.rules?.subTabAntispam, 'string', `missing admin.rules.subTabAntispam in ${locale}`);
    }
  });
});
