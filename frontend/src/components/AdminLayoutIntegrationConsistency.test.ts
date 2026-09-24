import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('./AdminPanel.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('AdminPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function region(name: string): ts.FunctionDeclaration {
  const declaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must exist`);
  return declaration;
}
function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  node.forEachChild(child => { result.push(child, ...descendants(child)); });
  return result;
}

for (const [id, state, setter] of [
  ['mobile-sidebar-swipe-setting', 'mobileSidebarSwipeEnabled', 'setMobileSidebarSwipeEnabled'],
  ['conversation-list-toggle', 'threadedView', 'setThreadedView'],
  ['conversation-reader-toggle', 'conversationReaderViewEnabled', 'setConversationReaderViewEnabled'],
]) {
  test(`${id} presents two described choices wired to its boolean preference`, () => {
    const choice = descendants(region('LayoutsTab')).find(node =>
      ts.isJsxSelfClosingElement(node) && node.attributes.properties.some(attribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'testId'
        && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === id));
    assert.ok(choice && ts.isJsxSelfClosingElement(choice));
    assert.equal(choice.tagName.getText(file), 'SettingsChoices');
    const text = choice.getText(file);
    assert.ok(text.includes(`value={${state} ? 'on' : 'off'}`));
    assert.ok(text.includes(`onChange={value => ${setter}(value === 'on')}`));
    const options = choice.attributes.properties.find(attribute =>
      ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'options');
    assert.ok(options && ts.isJsxAttribute(options) && options.initializer && ts.isJsxExpression(options.initializer));
    const expression = options.initializer.expression;
    assert.ok(expression && ts.isArrayLiteralExpression(expression));
    assert.equal(expression.elements.length, 2);
    for (const option of expression.elements) {
      assert.ok(ts.isArrayLiteralExpression(option));
      assert.equal(option.elements.length, 3, 'both options need labels and descriptions');
      assert.match(option.elements[2].getText(file), /t\('[^']+Desc'\)/);
    }
  });
}

test('loading provider configuration does not open either collapsed card', () => {
  const integrations = region('IntegrationsTab').getText(file);
  assert.match(integrations, /\[msExpanded, setMsExpanded\] = useState\(false\)/);
  assert.match(integrations, /\[googleExpanded, setGoogleExpanded\] = useState\(false\)/);
  const load = integrations.slice(integrations.indexOf('useEffect(() => {'), integrations.indexOf('}, [isAdmin]);'));
  assert.match(load, /api.getIntegrations\(\)/);
  assert.match(load, /api.getIntegrationsStatus\(\)/);
  assert.doesNotMatch(load, /set(?:Ms|Google)Expanded/);
});

test('provider headers expose equivalent keyboard-accessible disclosure state', () => {
  const integrations = region('IntegrationsTab').getText(file);
  for (const [provider, state] of [['microsoft', 'ms'], ['google', 'google']]) {
    assert.ok(integrations.includes(`aria-expanded={${state}Expanded}`));
    assert.ok(integrations.includes(`aria-controls="${provider}-provider-config"`));
    assert.ok(integrations.includes(`id="${provider}-provider-config"`));
  }
  assert.equal((integrations.match(/event.key === 'Enter' \|\| event.key === ' '/g) || []).length, 2);
  assert.equal((integrations.match(/style=\{providerHeaderStyle\}/g) || []).length, 2);
});

test('provider hints and responsive action layout match', () => {
  const integrations = region('IntegrationsTab').getText(file);
  const hints = [...integrations.matchAll(/data-testid="(?:google|microsoft)-accounts-hint" style=\{(\{[^\n]+\})\}/g)];
  assert.equal(hints.length, 2);
  assert.equal(hints[0][1], hints[1][1]);
  assert.equal((integrations.match(/style=\{providerActionsStyle\}/g) || []).length, 2);
  assert.match(integrations, /const providerActionsStyle[^;]+flexWrap: 'wrap'/);
  assert.match(integrations, /repeat\(auto-fit, minmax\(min\(100%, 220px\), 1fr\)\)/);
  assert.equal((integrations.match(/flex: 1, minWidth: 0, overflowWrap: 'anywhere'/g) || []).length, 2);
});
