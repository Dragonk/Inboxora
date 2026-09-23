import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const adminPanel = new URL('./AdminPanel.tsx', import.meta.url);
const mailApp = new URL('./MailApp.tsx', import.meta.url);
const contactsPage = new URL('./ContactsPage.tsx', import.meta.url);
// The address-book controls live in the manager panel now, so the contracts that used to match the
// `⋯` menu read it as well.
const contactsManager = new URL('./ContactsBooksManager.tsx', import.meta.url);
const calendarSidebar = new URL('./CalendarSidebar.tsx', import.meta.url);


test('a same-tab Google callback reports the connection instead of opening the accounts screen', async () => {
  const source = await readFile(mailApp, 'utf8');
  // Microsoft creates a mailbox and still opens Accounts; Google must not.
  assert.match(source, /if \(provider === 'google'\) \{/);
  assert.match(source, /contacts\.googleConnected\.title/);
  assert.match(source, /contacts\.googleConnected\.body/);
  // The Graph provider flow is also a connection, not a mailbox.
  assert.match(source, /provider === 'microsoft_graph'/);
  assert.match(source, /providers\.microsoftGraphConnected\.title/);
  assert.match(source, /providers\.microsoftGraphConnected\.body/);
});

test('the contacts screen offers the Google pull only when connected', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.googleContacts\.status\(\)/);
  const manager = await readFile(contactsManager, 'utf8');
  assert.match(manager, /data-testid={`contacts-manager-sync-\$\{syncTarget\}`}/);
  assert.match(source, /const runProviderContactsSync = async \(provider: 'google' \| 'microsoft' \| 'dav'\) => \{/);
  assert.match(source, /await api\.googleContacts\.sync\(\)/);
  // The control is offered by the manager for the target the book belongs to — its provider, or its DAV source
  // (DAV-05).
  assert.match(manager, /const syncTarget: 'google' \| 'microsoft' \| 'dav' \| null/);
  assert.match(manager, /syncTarget && \(/);
  // The result is reported per run, including a partial failure.
  assert.match(source, /contacts\.addressBooks\.googleSyncDone/);
  assert.match(source, /contacts\.addressBooks\.googleSyncPartial/);
  assert.match(source, /contacts-\$\{providerNotice\.provider\}-sync-result/);
});

test('the contacts screen offers the Microsoft pull through the same control', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.microsoftContacts\.status\(\)/);
  assert.match(source, /await api\.microsoftContacts\.sync\(\)/);
  const manager = await readFile(contactsManager, 'utf8');
  assert.match(manager, /data-testid={`contacts-manager-sync-\$\{syncTarget\}`}/);
  assert.match(manager, /syncTarget && \(/);
  assert.match(source, /contacts\.addressBooks\.microsoftSyncDone/);
  assert.match(source, /contacts\.addressBooks\.microsoftSyncPartial/);
  // Both providers must be loadable independently: one being absent cannot hide
  // the other's control.
  const statusCalls = source.match(/api\.(google|microsoft)Contacts\.status\(\)/g) ?? [];
  assert.equal(statusCalls.length, 2);
});



test('the calendar rail syncs exactly the selected account source', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /api\.syncAccountProviderFeature\(source\.accountId, 'calendars'\)/);
  assert.match(source, /data-testid="calendar-account-sync"/);
  assert.match(source, /data-testid="calendar-account-sync-result"/);
  assert.match(source, /api\.calendar\.presentation\(\)/);
  assert.match(source, /updateSourcePresentation/);
  assert.match(source, /updateCalendarPresentation/);
  assert.doesNotMatch(source, /providerCalendars\.sync\(/);
  assert.doesNotMatch(source, /calendar\.googleSyncing/);
});

test('the contacts screen can import a vCard file into a local book', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.addressBooks\.importVCard\(selectedAddressBookId/);
  const manager = await readFile(contactsManager, 'utf8');
  assert.match(manager, /data-testid="contacts-manager-import-vcard"/);
  assert.match(source, /accept="\.vcf,text\/vcard"/);
  assert.match(manager, /contacts\.addressBooks\.importVCard/);
  // Only a local book can receive an import, like the CSV importer.
  const localGuards = manager.match(/isLocal && <Button data-testid="contacts-manager-import-google"/);
  assert.ok(localGuards, 'import actions must be limited to local books');
});

test('a local calendar can import an .ics file from the appearance dialog', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /api\.calendar\.importIcs\(calendar\.id/);
  assert.match(source, /data-testid="calendar-import-ics"/);
  assert.match(source, /accept="\.ics,text\/calendar"/);
  assert.match(source, /calendar\.importIcs/);
  assert.match(source, /calendar\.importingIcs/);
});

test('each provider reports when it last synced, or that it failed', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /providerConnectorSummary\(googleContacts\?\.books/);
  assert.match(source, /providerConnectorSummary\(microsoftContacts\?\.books/);
  // The freshest time wins, and a recorded failure is shown instead of a time.
  assert.match(source, /contacts\.addressBooks\.lastSyncFailed/);
  const manager = await readFile(contactsManager, 'utf8');
  assert.match(manager, /contacts\.addressBooks\.lastSynced/);
  assert.match(manager, /data-testid={`contacts-manager-book-status-\$\{book\.id\}`}/);
});

test('the calendar connector reports the selected account outcome', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /response\.state !== 'success' \|\| failed > 0/);
  assert.match(source, /calendar\.providerSyncDone/);
  assert.match(source, /calendar\.providerSyncPartial/);
  assert.match(source, /data-testid="calendar-account-sync-result"/);
});

test('an actionable provider failure is explained instead of shown as a code', async () => {
  const source = await readFile(contactsPage, 'utf8');
  const sidebar = await readFile(calendarSidebar, 'utf8');
  const helper = await readFile(new URL('../utils/providerFailure.ts', import.meta.url), 'utf8');
  // The helper owns the literal keys; both surfaces route through it.
  assert.match(helper, /providers\.syncFailedAuth/);
  assert.match(helper, /providers\.syncFailedScopes/);
  assert.match(helper, /providers\.syncFailedRateLimited/);
  // Contacts use a summary, while calendar source sync passes each account's errors
  // to the same actionable formatter.
  assert.match(source, /failureKey: code => providerFailureKey\(code\) \?\? 'contacts\.addressBooks\.lastSyncFailed'/);
  assert.match(sidebar, /summariseProviderSyncErrors/);
  assert.match(source, /contacts\.addressBooks\.lastSyncFailed/);
  assert.match(sidebar, /failureSummary\?\.first/);
});

test('an import confirms what it added instead of refreshing silently', async () => {
  const source = await readFile(contactsPage, 'utf8');
  // Both importers report the count the server returns, through the same notice.
  const reports = source.match(/setImportNotice\(t\('contacts\.addressBooks\.importDone'/g) ?? [];
  assert.equal(reports.length, 2, 'both the CSV and vCard importers must confirm');
  assert.match(source, /data-testid="contacts-import-result"/);
  assert.match(source, /count: result\?\.imported \?\? 0/);
});

test('a calendar import confirms its result and leaves the dialog open', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /setImportNotice\(protectedCount/);
  assert.match(source, /calendar\.importProtected/);
  assert.match(source, /data-testid="calendar-import-result"/);
  // The confirmation is only useful if the dialog stays open to show it.
  const successPath = /importDone'[\s\S]{0,200}?await onSourcesChanged\(\)/.exec(source)?.[0] ?? '';
  assert.ok(successPath, 'the success path must refresh the calendars');
  assert.doesNotMatch(successPath, /setCalendarEdit\(null\)/);
  // A stale confirmation must not greet the next calendar.
  assert.match(source, /setOpenCalendarMenu\(null\); setEditError\(null\); setImportNotice\(''\);/);
});

test('a configured but unconnected provider says so on the contacts page', async () => {
  const source = await readFile(contactsPage, 'utf8');
  // Silence is the wrong answer when the administrator has already made it possible.
  // The flags the manager needs are taken from the provider status the page already loaded.
  assert.match(source, /configured: !!googleContacts\?\.configured/);
  assert.match(source, /connected: !!googleContacts\?\.connected/);
  assert.match(source, /configured: !!microsoftContacts\?\.configured/);
  assert.match(source, /connected: !!microsoftContacts\?\.connected/);
  const manager = await readFile(contactsManager, 'utf8');
  assert.match(manager, /data-testid="contacts-manager-connect-hint"/);
  assert.match(manager, /providers\.connectGoogleHint/);
  assert.match(manager, /providers\.connectMicrosoftHint/);
  // The hint must not replace the sync control for a provider that *is* connected.
  assert.match(manager, /syncTarget && \(/);
});

test('the account sync copy reports that account’s own result', async () => {
  const contacts = await readFile(contactsPage, 'utf8');
  const sidebar = await readFile(calendarSidebar, 'utf8');
  assert.match(contacts, /count: book => book\.contactCount \?\? 0/);
  assert.match(sidebar, /const values = \{ calendars: outcome\.collections \?\? 0/);
  const strings = JSON.parse(await readFile(new URL('../locales/en.json', import.meta.url), 'utf8'));
  assert.match(strings.calendar.providerSyncDone, /\{\{provider\}\}/);
  assert.match(strings.calendar.providerSyncPartial, /\{\{failed\}\}/);
});

test('an import confirmation does not follow the user to another address book', async () => {
  const source = await readFile(contactsPage, 'utf8');
  // The notice renders outside the address-book menu, so a stale one is visible.
  assert.match(source, /useEffect\(\(\) => \{ setImportNotice\(''\); \}, \[selectedAddressBookId\]\)/);
});




test('the drawer swipe gesture is reachable: default on, with a switch to turn it off', async () => {
  const panel = await readFile(adminPanel, 'utf8');
  const store = await readFile(new URL('../store/index.ts', import.meta.url), 'utf8');
  // A gesture that is on by default but has no switch is a preference nobody can change,
  // and one whose refs are unattached is dead code; both are pinned here.
  assert.match(panel, /testId="mobile-sidebar-swipe-setting"/);
  assert.match(panel, /onChange={setMobileSidebarSwipeEnabled}/);
  assert.match(panel, /admin\.appearance\.mobileSidebarSwipe/);
  assert.match(store, /mobileSidebarSwipeEnabled: true/);
  // The preference reaches the server allow-list, so a saved choice survives a reload.
  const auth = await readFile(new URL('../../../backend/src/routes/auth.ts', import.meta.url), 'utf8');
  assert.match(auth, /mobileSidebarSwipeEnabled must be a boolean/);
});




test('a failed authorization is reported, and in words a user can act on', async () => {
  const panel = await readFile(adminPanel, 'utf8');
  const mail = await readFile(new URL('./MailApp.tsx', import.meta.url), 'utf8');
  // The popup path showed the raw provider code; the sentence for it already existed.
  assert.match(panel, /const failureKey = providerFailureKey\(typeof e\.data\.error === 'string' \? e\.data\.error : null\)/);
  assert.match(panel, /setSaveMsg\(failureKey \? t\(failureKey\) : 'Error: ' \+ e\.data\.error\)/);
  // The same-tab path cleared the URL and said nothing at all, so a failed connect looked like
  // nothing happening.
  assert.match(mail, /const key = providerFailureKey\(oauthError\)/);
  assert.match(mail, /title: t\('providers\.connectFailedTitle'\)/);
});

test('changing the Client ID warns before saving, since the stored secret belongs to the old one', async () => {
  const source = await readFile(adminPanel, 'utf8');
  // AD07 against AD05: the API preserves an omitted secret, so the warning has to come from the card, and
  // only when the secret field is untouched — a new secret is the other way to resolve the pairing.
  assert.match(source, /admin\.integrations\.clientIdChangeConfirm/);
  assert.match(source, /const googleSecretUntouched = !googleForm\.clientSecret \|\| googleForm\.clientSecret === storedGoogle\?\.clientSecret/);
  assert.match(source, /const msSecretUntouched = !msForm\.clientSecret \|\| msForm\.clientSecret === storedMs\?\.clientSecret/);
  assert.match(source, /if \(!window\.confirm\(t\('admin\.integrations\.clientIdChangeConfirm'\)\)\) return;/);
});

test('the provider cards start no authorization for a user, and say where mailboxes are added', async () => {
  const source = await readFile(adminPanel, 'utf8');
  // Every user-level action is gone from Integrations: no mailbox sign-in, no Graph connector, no
  // device-code connect, no Google calendar/contacts connect, no per-user connection list, no per-connection
  // push control. Those belong to the mailbox they authorise, on its card in Settings -> Accounts.
  for (const testid of [
    'google-connect', 'google-connect-calendars', 'microsoft-graph-connect',
    'microsoft-graph-device-connect', 'google-connected-account', 'microsoft-connected-account',
    'google-disconnect-account', 'microsoft-disconnect-account', 'provider-push-google', 'provider-push-microsoft',
  ]) {
    assert.ok(!source.includes(testid), `${testid} is still rendered in Integrations`);
  }
  assert.ok(!source.includes('handleConnectGoogle'));
  assert.ok(!source.includes('handleConnectMicrosoftGraph'));
  assert.ok(!source.includes('handleStartGraphDeviceFlow'));
  // And each card points to the place that does manage them.
  assert.match(source, /admin\.integrations\.microsoft\.connectInAccounts/);
  assert.match(source, /admin\.integrations\.google\.connectInAccounts/);
  assert.match(source, /data-testid="microsoft-accounts-only"/);
  assert.match(source, /data-testid="google-accounts-only"/);
});
