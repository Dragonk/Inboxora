import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Settings → Integrations configures **provider applications**; Settings → Accounts connects **individual
 * mailboxes**. These cases pin that separation in the source, because it is the kind of thing that quietly
 * regresses the next time a button is added to a provider card.
 */

const panel = new URL('./AdminPanel.tsx', import.meta.url);
const flow = new URL('./AddAccountFlow.tsx', import.meta.url);

test('Integrations starts no mailbox authorization', async () => {
  const source = await readFile(panel, 'utf8');
  const integrations = source.slice(source.indexOf('function IntegrationsTab'), source.indexOf('function SSOTab'));
  // No mail-account sign-in and no account-adding flow: the account's own OAuth belongs to Accounts.
  assert.doesNotMatch(integrations, /\/oauth\/microsoft['"`]/);
  assert.doesNotMatch(integrations, /handleConnectMs/);
  assert.doesNotMatch(integrations, /addNativeAccount/);
  assert.doesNotMatch(integrations, /purpose=new_account/);
  // The configuration surface is still there, with the pointer to where mailboxes are added.
  assert.match(integrations, /admin\.integrations\.microsoft\.save/);
  assert.match(integrations, /ProviderConfigTest/);
  assert.match(integrations, /data-testid="microsoft-accounts-hint"/);
  assert.match(integrations, /data-testid="google-accounts-hint"/);
  assert.match(integrations, /admin\.integrations\.accountHint/);
});

test('Accounts offers the three mailbox kinds before any form', async () => {
  const source = await readFile(panel, 'utf8');
  assert.match(source, /<AddAccountFlow/);
  // The IMAP form is a separate subview, reached from the chooser.
  assert.match(source, /subview === 'add-imap'/);
  assert.match(source, /onChooseImap=\{\(\) => setSubview\('add-imap'\)\}/);
  // The chooser itself knows the three kinds and their actions.
  const component = await readFile(flow, 'utf8');
  for (const kind of ['microsoft', 'google', 'imap']) {
    assert.match(component, new RegExp(`add-account-choice-\\$\\{choice\\.key\\}|add-account-choice-${kind}|'${kind}' as const`), `missing ${kind} choice`);
  }
  assert.match(component, /add-account-microsoft-browser/);
  assert.match(component, /add-account-microsoft-device/);
  assert.match(component, /add-account-google-browser/);
  assert.match(component, /add-account-google-imap/);
});

test('a provider that is not configured shows a setup hint, and an admin can go to Integrations', async () => {
  const component = await readFile(flow, 'utf8');
  assert.match(component, /add-account-setup-hint-\$\{provider\}/);
  // The hint is built from the provider name, so both keys are reached from one template.
  assert.match(component, /addAccountFlow\.\$\{provider\}NotConfigured/);
  assert.match(component, /add-account-goto-integrations-\$\{provider\}/);
  assert.match(component, /goToIntegrations/);
  // The hint is offered only to an administrator, who is the one who can configure the provider.
  assert.match(component, /isAdmin \? \(/);
  // Secrets are never part of this screen.
  assert.doesNotMatch(component, /clientSecret|ClientSecret|tenantId|redirectUri/i);
});

test('the provider authorization is the existing flow, with the mail scopes', async () => {
  const component = await readFile(flow, 'utf8');
  // Microsoft: the provider connector with the mail purpose; Google: the browser flow for a new account.
  assert.match(component, /\/oauth\/provider\/microsoft\?purpose=mail_migration/);
  assert.match(component, /\/oauth\/google\?purpose=new_account/);
  assert.match(component, /startProviderMsDeviceFlow\('mail_migration'\)/);
  // The account is created from the authorization, with the provider's identity.
  assert.match(component, /api\.addNativeAccount\(\{ provider \}\)/);
  // No Google device flow is offered.
  assert.doesNotMatch(component, /googleDevice|startGoogleDevice/i);
});

test('an existing account is never duplicated: the screen offers the migration', async () => {
  const component = await readFile(flow, 'utf8');
  assert.match(component, /failure\.code === 'ACCOUNT_EXISTS'/);
  assert.match(component, /add-account-duplicate/);
  assert.match(component, /add-account-duplicate-migrate/);
  assert.match(component, /api\.migrateAccount\(duplicate\.accountId/);
  assert.match(component, /migrateMicrosoft|migrateGoogle/);
});

test('a native account is not edited as an IMAP account', async () => {
  const source = await readFile(panel, 'utf8');
  assert.match(source, /const nativeTransport = isEdit && \(initial\?\.mail_transport === 'microsoft_graph' \|\| initial\?\.mail_transport === 'gmail_api'\)/);
  assert.match(source, /data-testid="native-transport-section"/);
  assert.match(source, /admin\.accounts\.addAccountFlow\.nativeTransport/);
  // The IMAP/SMTP fields live inside the non-native branch.
  const gated = source.slice(source.indexOf('{nativeTransport ? ('), source.indexOf("{t('admin.accounts.addAccountFlow.nativeTransport'"));
  assert.match(gated, /\{nativeTransport \? \(/);
  assert.match(source, /admin\.accounts\.imapHost/);
});

test('the account card carries the provider services, and the classifier decides the migration', async () => {
  const panel = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
  const services = await readFile(new URL('./AccountProviderServices.tsx', import.meta.url), 'utf8');
  // Mounted on every account card, driven by the backend's account-centric feature view.
  assert.match(panel, /<AccountProviderServices accountId=\{account\.id\} reload=\{loadAccounts\} t=\{t\} \/>/);
  assert.match(services, /api\.accountProviderFeatures\(accountId\)/);
  // The transport is named, and a migration is offered only when the backend says it applies.
  assert.match(services, /data-testid="account-transport"/);
  assert.match(services, /features\.mail\.migrationAvailable &&/);
  assert.match(services, /data-testid="account-migrate-native"/);
  // The migration names the provider, and a missing authorization starts the provider's flow first.
  assert.match(services, /api\.migrateAccount\(accountId, \{ provider \}\)/);
  assert.match(services, /failure\.code === 'PROVIDER_AUTH_REQUIRED'/);
  assert.match(services, /\/oauth\/google\?purpose=\$\{purpose\}/);
  assert.match(services, /\/oauth\/provider\/microsoft\?purpose=\$\{purpose\}/);
  // Calendar and contacts are per-account services, and push is reported per service.
  // One authorization for the whole mailbox, not one per service: three consents for one account let the
  // calendar be granted to a different mailbox than the mail it sits beside.
  assert.match(services, /data-testid="account-connect"/);
  assert.match(services, /authorize\(provider, 'account'\)/);
  assert.match(services, /data-testid="account-refresh"/);
  assert.ok(!/account-service-connect-/.test(services), 'a per-service connect action is still rendered');
  assert.match(services, /features\.push\.mail/);
  assert.match(services, /features\.push\.contacts/);
});

test('the add-account screen survives a 360 px viewport', async () => {
  const component = await readFile(flow, 'utf8');
  // Every grid is content-sized and never wider than its container, so no fixed desktop grid can overflow.
  assert.doesNotMatch(component, /gridTemplateColumns: '\d+px/);
  // The account services stack their actions with flexWrap, so Mail/Calendar/Contacts never force a
  // horizontal scroll on a 360 px screen either.
  const services = await readFile(new URL('./AccountProviderServices.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(services, /gridTemplateColumns: '\d+px/);
  assert.match(services, /flexWrap: 'wrap'/);
  assert.match(services, /minWidth: 0/);
  assert.doesNotMatch(component, /minWidth: \d{3,}/);
  assert.match(component, /gridTemplateColumns: 'repeat\(auto-fit, minmax\(min\(220px, 100%\), 1fr\)\)'/);
  assert.match(component, /maxWidth: '100%', minWidth: 0/);
});
