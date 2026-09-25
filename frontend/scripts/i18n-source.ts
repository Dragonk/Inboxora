import ts from 'typescript';

export interface SourceFinding { line: number; kind: string; text: string }
export interface SourceAudit { keys: string[]; findings: SourceFinding[] }
const attributes = new Set(['title', 'placeholder', 'aria-label', 'aria-description', 'alt', 'label', 'description', 'emptyText', 'helperText', 'closeLabel', 'actionLabel']);
const messages = new Set(['alert', 'confirm', 'prompt', 'setError', 'setNotice', 'setSuccess', 'setToast']);

/** Inspect syntax, not comments or regex-shaped examples. No filename baselines. */
export function auditSource(file: string, text: string): SourceAudit {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys = new Set<string>();
  const findings: SourceFinding[] = [];
  const seen = new Set<number>();
  const report = (node: ts.Node, value: string, kind: string) => {
    const normalized = value.replace(/&(?:lt|gt|amp|quot|apos|nbsp|middot|times);|&#(?:\d+|x[\da-f]+);/gi, '').replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(normalized) || seen.has(node.pos)) return;
    seen.add(node.pos);
    findings.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, text: normalized });
  };
  const resolving = new Set<ts.Node>();
  const literals = (node: ts.Node | undefined, accept: (node: ts.Node, value: string) => void) => {
    if (!node || resolving.has(node)) return;
    if (ts.isIdentifier(node)) {
      // Follow local constants used in titles, notifications or rendered text.
      // Respect block/function shadowing; never treat an unrelated same-named
      // constant elsewhere in the file as this expression's value.
      for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
          for (const statement of scope.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === node.text);
            if (declaration) {
              resolving.add(node);
              literals(declaration.initializer, accept);
              resolving.delete(node);
              return;
            }
          }
        }
        if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === node.text)) return;
      }
      return;
    }
    if (ts.isStringLiteralLike(node)) accept(node, node.text);
    else if (ts.isTemplateExpression(node)) accept(node, node.head.text + node.templateSpans.map(span => span.literal.text).join(''));
    else if (ts.isConditionalExpression(node)) { literals(node.whenTrue, accept); literals(node.whenFalse, accept); }
    else if (ts.isParenthesizedExpression(node)) literals(node.expression, accept);
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) literals(node.left, accept);
      literals(node.right, accept);
    }
  };
  const walk = (node: ts.Node) => {
    // CSS and scripts are executable syntax, not rendered language.
    if (ts.isJsxElement(node) && ['style', 'script'].includes(node.openingElement.tagName.getText(source))) return;
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text');
    if (ts.isJsxAttribute(node) && attributes.has(node.name.getText(source))) {
      const value = node.initializer;
      literals(value && ts.isJsxExpression(value) ? value.expression : value, (n, v) => report(n, v, 'UI attribute'));
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) literals(node.expression, (n, v) => report(n, v, 'JSX expression'));
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (name === 't') literals(node.arguments[0], (n, value) => { if (!ts.isTemplateExpression(n)) keys.add(value); });
      if (messages.has(name)) literals(node.arguments[0], (n, value) => report(n, value, 'UI message'));
      // Existing formatting helpers pass the accessible tooltip as argument two.
      if (name === 'tb' || name === 'mtb') literals(node.arguments[1], (n, value) => report(n, value, 'Toolbar tooltip'));
      if (name === 'addNotification' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(property) && ['title', 'body', 'actionLabel'].includes(property.name.getText(source).replace(/['"]/g, ''))) {
            literals(property.initializer, (n, value) => report(n, value, 'Notification'));
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return { keys: [...keys].sort(), findings };
}
