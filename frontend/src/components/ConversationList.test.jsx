import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationList from './ConversationList.jsx';

test('renders the conversation list component', () => {
  const html = renderToStaticMarkup(<ConversationList params={{}} />);
  assert.ok(html);
});
