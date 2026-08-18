import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationPane from './ConversationPane.jsx';

test('renders the conversation pane component', () => {
  const html = renderToStaticMarkup(<ConversationPane conversationId="c1" />);
  assert.ok(html);
});
