import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
function translationCalls(file: string) {
  const calls: string[] = [];
  const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) calls.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return calls;
}

const expected: Record<string, Record<string, number>> = {
  'AdminPanel.tsx': {
    'admin.integrations.appUrlRequired': 2,
    'admin.systemEmail.starttlsOption': 1,
    'admin.systemEmail.tlsOption': 1,
    'admin.systemEmail.noSecurityOption': 1,
    'admin.rules.valuePlaceholder': 1,
    'admin.rules.unnamed': 1,
    'admin.accounts.loadFoldersError': 1,
    'admin.accounts.saveFolderMappingsError': 1,
  },
  'ComposeModal.tsx': {
    'compose.toolbar.backToRichText': 2,
    'signatureEditor.sourceMode': 2,
    'admin.accounts.signatureSection': 2,
    'compose.toolbar.removeLink': 1,
    'compose.toolbar.emoji': 1,
    'compose.partialDeliveryTitle': 1,
    'compose.partialDeliveryBody': 1,
    'compose.partialDeliveryRecipients': 1,
    'compose.toolbar.alignLeft': 2,
    'compose.toolbar.alignCenter': 2,
    'compose.toolbar.alignRight': 2,
    'signatureEditor.bold': 2,
    'signatureEditor.italic': 2,
    'signatureEditor.underline': 2,
    'signatureEditor.strikethrough': 2,
    'richTextEditor.bulletList': 2,
    'richTextEditor.orderedList': 2,
  },
  'CalendarPage.tsx': { 'calendar.invitationCancellationSent': 1, 'calendar.invitationCancellationStatus': 1 },
  'MessagePane.tsx': { 'compose.cc': 4, 'message.forwardedMessage': 1, 'message.date': 2 },
  'Sidebar.tsx': { 'admin.cleanup.account': 3 },
  'MessageList.tsx': { 'messageList.searchHelp.example': 1 },
  'ElectronNotificationBridge.tsx': {
    'nativeUpdates.ready': 2,
    'nativeUpdates.manualInstall': 2,
    'nativeUpdates.verified': 1,
    'nativeUpdates.downloaded': 1,
    'nativeUpdates.copyAndQuit': 2,
    'nativeUpdates.install': 1,
    'nativeUpdates.copyFailed': 1,
    'nativeUpdates.copyFailedBody': 1,
    'nativeUpdates.installFailed': 1,
    'nativeUpdates.installFailedBody': 1,
    'nativeUpdates.syncStarted': 1,
    'nativeUpdates.syncStartedBody': 1,
    'nativeUpdates.syncFailed': 1,
    'nativeUpdates.syncFailedBody': 1,
  },
};

for (const [file, keys] of Object.entries(expected)) {
  test(`${file} translates audited labels in every responsive branch`, () => {
    const calls = translationCalls(file);
    for (const [key, count] of Object.entries(keys)) {
      assert.equal(calls.filter(value => value === key).length, count, key);
    }
  });
}

test('forward and print metadata translate labels and escape hostile text', () => {
  const pane = source('MessagePane.tsx');
  const escapeDefinition = pane.match(/const esc = ([^\n]+);/);
  assert.ok(escapeDefinition);
  const script = ts.transpileModule(`(${escapeDefinition[1]})(input)`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.equal(runInNewContext(script, { input: '<img src=x onerror=alert(1)> & sender@example.com' }), '&lt;img src=x onerror=alert(1)&gt; &amp; sender@example.com');
  assert.ok(pane.includes("[forwardHeading, ...forwardHeaders].map(esc).join('<br>')"), 'every forwarded label and metadata value is escaped');
  for (const key of ['compose.from', 'compose.to', 'compose.cc', 'message.date']) {
    assert.ok(pane.includes(`esc(t('${key}'))`), `print escapes translated ${key}`);
  }
  assert.ok(pane.includes("esc(message.subject || t('common.noSubject'))"));
  assert.equal(pane.split('new Date(message.date).toLocaleString(i18n.language)').length - 1, 2);
  assert.ok(pane.includes("message.subject?.startsWith('Fwd:')"), 'mail subject convention remains unchanged');
});

test('localization preserves machine values and native installation commands', () => {
  const admin = source('AdminPanel.tsx');
  for (const value of ['STARTTLS', 'SSL', 'none']) assert.ok(admin.includes(`<option value="${value}">`));
  assert.ok(admin.includes('placeholder="email"'), 'OIDC email claim is not a translated label');
  const native = source('ElectronNotificationBridge.tsx');
  assert.ok(native.includes("t('nativeUpdates.manualInstall', { command: installCommand })"));
  assert.ok(native.includes("t('nativeUpdates.manualInstall', { command: result.installCommand })"));
  assert.ok(native.includes('[addNotification, nativeBridgeReady, t]'), 'updater listener follows language changes');
});
