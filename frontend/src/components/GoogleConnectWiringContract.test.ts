import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const adminPanel = new URL('./AdminPanel.tsx', import.meta.url);
const mailApp = new URL('./MailApp.tsx', import.meta.url);
const contactsPage = new URL('./ContactsPage.tsx', import.meta.url);
const calendarSidebar = new URL('./CalendarSidebar.tsx', import.meta.url);
const localesDir = new URL('../locales/', import.meta.url);

test('the Google provider card offers an account connection once the browser flow is ready', async () => {
  const source = await readFile(adminPanel, 'utf8');
  assert.match(source, /data-testid="google-connect"/);
  // One authorization per feature: a contacts grant cannot read calendars.
  assert.match(source, /const handleConnectGoogle = \(purpose: 'contacts_enable' \| 'calendar_enable'\) => \{/);
  assert.match(source, /a\.href = `\/oauth\/google\?purpose=\$\{purpose\}&access=read_only`/);
  assert.match(source, /data-testid="google-connect-calendars"/);
  assert.match(source, /handleConnectGoogle\('calendar_enable'\)/);
  assert.match(source, /googleStatus\?\.browser\?\.ready \? \(/);
  assert.match(source, /admin\.integrations\.google\.connectUnavailable/);
  // A completed popup flow updates the Google card (no mailbox is created).
  assert.match(source, /e\.data\?\.provider === 'google'/);
  assert.match(source, /admin\.integrations\.google\.connectedNote/);
  assert.match(source, /setConnectingGoogle\(false\)/);
});

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
  assert.match(source, /data-testid="contacts-google-sync"/);
  assert.match(source, /const runProviderContactsSync = async \(provider: 'google' \| 'microsoft'\) => \{/);
  assert.match(source, /await api\.googleContacts\.sync\(\)/);
  assert.match(source, /googleContacts\?\.connected &&/);
  // The result is reported per run, including a partial failure.
  assert.match(source, /contacts\.addressBooks\.googleSyncDone/);
  assert.match(source, /contacts\.addressBooks\.googleSyncPartial/);
  assert.match(source, /contacts-\$\{providerNotice\.provider\}-sync-result/);
});

test('the contacts screen offers the Microsoft pull through the same control', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.microsoftContacts\.status\(\)/);
  assert.match(source, /await api\.microsoftContacts\.sync\(\)/);
  assert.match(source, /data-testid="contacts-microsoft-sync"/);
  assert.match(source, /microsoftContacts\?\.connected &&/);
  assert.match(source, /contacts\.addressBooks\.microsoftSyncDone/);
  assert.match(source, /contacts\.addressBooks\.microsoftSyncPartial/);
  // Both providers must be loadable independently: one being absent cannot hide
  // the other's control.
  const statusCalls = source.match(/api\.(google|microsoft)Contacts\.status\(\)/g) ?? [];
  assert.equal(statusCalls.length, 2);
});

test('the Microsoft card offers the Graph connection as its own action', async () => {
  const source = await readFile(adminPanel, 'utf8');
  assert.match(source, /data-testid="microsoft-graph-connect"/);
  assert.match(source, /const handleConnectMicrosoftGraph = \(\) => \{/);
  assert.match(source, /a\.href = '\/oauth\/provider\/microsoft\?purpose=contacts_enable&access=read_only'/);
  // It is a separate authorisation: the mailbox sign-in above stays untouched.
  assert.match(source, /admin\.integrations\.microsoft\.graphHint/);
  // Gated on the connector's own readiness: the mailbox flow has a different callback,
  // and tying them together hid this button where the connector could actually run.
  assert.match(source, /msStatus\?\.graph\?\.ready && \(/);
});

test('every locale translates the Google connect and sync controls', async () => {
  const files = (await readdir(localesDir)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 9);
  const adminKeys = ['connect', 'connecting', 'connectHint', 'connectUnavailable', 'connectedNote'];
  const bookKeys = ['googleSync', 'googleSyncing', 'googleSyncDone', 'googleSyncPartial', 'microsoftSync', 'microsoftSyncing', 'microsoftSyncDone', 'microsoftSyncPartial'];
  const microsoftKeys = ['graphConnect', 'graphConnecting', 'graphHint'];
  const calendarKeys = ['googleTitle', 'googleHint', 'googleSync', 'googleSyncing', 'googleSyncDone', 'googleSyncPartial', 'googleNotConnected'];
  for (const name of files) {
    const strings = JSON.parse(await readFile(new URL(name, localesDir), 'utf8'));
    for (const key of adminKeys) {
      assert.equal(typeof strings.admin.integrations.google[key], 'string', `${name} is missing admin.integrations.google.${key}`);
      assert.ok(strings.admin.integrations.google[key].length > 0, `${name} has an empty ${key}`);
    }
    for (const key of bookKeys) {
      assert.equal(typeof strings.contacts.addressBooks[key], 'string', `${name} is missing contacts.addressBooks.${key}`);
      assert.ok(strings.contacts.addressBooks[key].length > 0, `${name} has an empty ${key}`);
    }
    for (const key of calendarKeys) {
      assert.equal(typeof strings.calendar[key], 'string', `${name} is missing calendar.${key}`);
      assert.ok(strings.calendar[key].length > 0, `${name} has an empty ${key}`);
    }
    for (const key of microsoftKeys) {
      assert.equal(typeof strings.admin.integrations.microsoft[key], 'string', `${name} is missing admin.integrations.microsoft.${key}`);
      assert.ok(strings.admin.integrations.microsoft[key].length > 0, `${name} has an empty ${key}`);
    }
    assert.equal(typeof strings.contacts.googleConnected.title, 'string', `${name} is missing contacts.googleConnected.title`);
    assert.equal(typeof strings.contacts.googleConnected.body, 'string', `${name} is missing contacts.googleConnected.body`);
    assert.equal(typeof strings.providers.microsoftGraphConnected.title, 'string', `${name} is missing providers.microsoftGraphConnected.title`);
    assert.equal(typeof strings.providers.microsoftGraphConnected.body, 'string', `${name} is missing providers.microsoftGraphConnected.body`);
    // The sync summaries interpolate with i18next syntax.
    assert.match(strings.contacts.addressBooks.googleSyncDone, /\{\{created\}\}/, `${name} googleSyncDone has no placeholders`);
    assert.match(strings.calendar.googleSyncDone, /\{\{calendars\}\}/, `${name} calendar googleSyncDone has no placeholders`);
    assert.match(strings.calendar.googleSyncPartial, /\{\{failed\}\}/, `${name} calendar googleSyncPartial has no placeholders`);
  }
});

test('the calendar sources dialog offers the Google pull once connected', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /api\.calendar\.googleCalendars\.status\(\)/);
  assert.match(source, /await api\.calendar\.googleCalendars\.sync\(\)/);
  assert.match(source, /data-testid="calendar-google-sync"/);
  assert.match(source, /googleCalendars\?\.connected \?/);
  assert.match(source, /calendar\.googleNotConnected/);
  // A partial run counts a failed connection and a failed calendar, so it never
  // looks like a complete one.
  assert.match(source, /calendar\.googleSyncPartial/);
  assert.match(source, /data-testid="calendar-google-sync-result"/);
  // The imported calendars appear immediately after a run.
  assert.match(source, /await loadGoogleCalendars\(\);\s*\n\s*await onSourcesChanged\(\);/);
});

test('the contacts screen can import a vCard file into a local book', async () => {
  const source = await readFile(contactsPage, 'utf8');
  assert.match(source, /api\.addressBooks\.importVCard\(selectedAddressBookId/);
  assert.match(source, /data-testid="contacts-import-vcard"/);
  assert.match(source, /accept="\.vcf,text\/vcard"/);
  assert.match(source, /contacts\.addressBooks\.importVCard/);
  // Only a local book can receive an import, like the CSV importer.
  const localGuards = source.match(/selectedBook\?\.source === 'local' && <Button/);
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
  assert.match(source, /contacts\.addressBooks\.lastSynced/);
  assert.match(source, /contacts\.addressBooks\.lastSyncFailed/);
  assert.match(source, /data-testid="contacts-google-sync-status"/);
  assert.match(source, /data-testid="contacts-microsoft-sync-status"/);
});

test('the calendar connector reports when it last synced, or that it failed', async () => {
  const source = await readFile(calendarSidebar, 'utf8');
  assert.match(source, /providerConnectorSummary\(googleCalendars\?\.calendars/);
  assert.match(source, /calendar\.lastSynced/);
  assert.match(source, /calendar\.lastSyncFailed/);
  assert.match(source, /data-testid="calendar-google-sync-status"/);
});

test('an actionable provider failure is explained instead of shown as a code', async () => {
  const source = await readFile(contactsPage, 'utf8');
  const sidebar = await readFile(calendarSidebar, 'utf8');
  const helper = await readFile(new URL('../utils/providerFailure.ts', import.meta.url), 'utf8');
  // The helper owns the literal keys; both surfaces route through it.
  assert.match(helper, /providers\.syncFailedAuth/);
  assert.match(helper, /providers\.syncFailedScopes/);
  assert.match(helper, /providers\.syncFailedRateLimited/);
  // The mapping is wired through the summary helper's failureKey, one per surface.
  assert.match(source, /failureKey: code => providerFailureKey\(code\) \?\? 'contacts\.addressBooks\.lastSyncFailed'/);
  assert.match(sidebar, /failureKey: code => providerFailureKey\(code\) \?\? 'calendar\.lastSyncFailed'/);
  // A code with no known action keeps the raw code rather than a friendly guess.
  assert.match(source, /contacts\.addressBooks\.lastSyncFailed/);
  assert.match(sidebar, /calendar\.lastSyncFailed/);
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
  assert.match(source, /googleContacts\?\.configured && !googleContacts\?\.connected && <span data-testid="contacts-google-connect-hint"/);
  assert.match(source, /microsoftContacts\?\.configured && !microsoftContacts\?\.connected && <span data-testid="contacts-microsoft-connect-hint"/);
  assert.match(source, /providers\.connectGoogleHint/);
  assert.match(source, /providers\.connectMicrosoftHint/);
  // The hint must not replace the sync control for a provider that *is* connected.
  assert.match(source, /googleContacts\?\.connected && <Button data-testid="contacts-google-sync"/);
});

test('the last-sync line reports the total the connector holds', async () => {
  const contacts = await readFile(contactsPage, 'utf8');
  const sidebar = await readFile(calendarSidebar, 'utf8');
  // The count is a total across books/calendars while the date is the freshest sync, so
  // the message must not imply the count belongs to that one time.
  assert.match(contacts, /count: book => book\.contactCount \?\? 0/);
  assert.match(sidebar, /count: calendar => calendar\.eventCount \?\? 0/);
  const strings = JSON.parse(await readFile(new URL('../locales/en.json', import.meta.url), 'utf8'));
  assert.match(strings.contacts.addressBooks.lastSynced, /\{\{count\}\}/);
  assert.match(strings.contacts.addressBooks.lastSynced, /in total/);
  assert.match(strings.calendar.lastSynced, /\{\{count\}\}/);
  assert.match(strings.calendar.lastSynced, /in total/);
});

test('an import confirmation does not follow the user to another address book', async () => {
  const source = await readFile(contactsPage, 'utf8');
  // The notice renders outside the address-book menu, so a stale one is visible.
  assert.match(source, /useEffect\(\(\) => \{ setImportNotice\(''\); \}, \[selectedAddressBookId\]\)/);
});

test('the opener acknowledges the Graph connector popup, which posts its own provider', async () => {
  const source = await readFile(adminPanel, 'utf8');
  // The popup posts `oauth_success=<provider>`; the Graph flow posts 'microsoft_graph',
  // which no branch handled, so the connection went unacknowledged in the opener.
  assert.match(source, /e\.data\?\.provider === 'microsoft_graph'/);
  assert.match(source, /admin\.integrations\.microsoft\.graphConnectedNote/);
  assert.match(source, /data-testid="microsoft-graph-connected"/);
  // It must be its own confirmation, not the mailbox one: they are different grants.
  assert.match(source, /setGraphSaveMsg\(t\('admin\.integrations\.microsoft\.graphConnectedNote'\)\)/);
  assert.match(source, /setConnectingGraph\(false\)/);
  // Every provider the flows redirect with must have a branch.
  for (const provider of ['google', 'microsoft', 'microsoft_graph']) {
    assert.match(source, new RegExp(`provider === '${provider}'`), `no opener branch for ${provider}`);
  }
});

test('a failed authorization releases every connect button, not only the mailbox one', async () => {
  const source = await readFile(adminPanel, 'utf8');
  const errorBranch = /e\.data\?\.type === 'oauth_error'\)\s*\{([\s\S]*?)\} else if/.exec(source)?.[1] ?? '';
  assert.ok(errorBranch, 'the oauth_error branch must exist');
  for (const flag of ['setConnectingMs', 'setConnectingGoogle', 'setConnectingGraph']) {
    assert.match(errorBranch, new RegExp(flag), `${flag} must be released on error`);
  }
});

test('the connect buttons ask for read access, which is all the connectors use', async () => {
  const source = await readFile(adminPanel, 'utf8');
  // Both connectors only read, so a write scope would be a permission the user cannot see
  // a reason for. The server honours `access=read_only` by narrowing the scope.
  const urls = source.match(/a\.href = [^;]*purpose=[^;]*;/g) ?? [];
  assert.equal(urls.length, 2, 'both connect actions must be covered');
  for (const url of urls) assert.match(url, /access=read_only/, url);
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

test('a connect button is offered only when its own flow can run', async () => {
  const source = await readFile(adminPanel, 'utf8');
  // The mailbox method needs a confidential client, so a client id alone must not enable
  // it — while the device method, which has its own control, legitimately works with one.
  assert.match(source, /const msBrowserReady = Boolean\(msStatus\?\.browser\?\.ready\)/);
  assert.match(source, /disabled=\{!msConfigured \|\| !msBrowserReady \|\| connectingMs\}/);
  assert.match(source, /cursor: msConfigured && msBrowserReady && !connectingMs \? 'pointer' : 'not-allowed'/);
  // The connector has a different callback again, and its own readiness.
  assert.match(source, /msStatus\?\.graph\?\.ready && \(/);
  // Google has a single flow, gated on the browser readiness for the same reason.
  assert.match(source, /googleStatus\?\.browser\?\.ready \? \(/);
});
