import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationPane from './ConversationPane.jsx';

it('renders the conversation pane component', () => {
  const html = renderToStaticMarkup(<ConversationPane conversationId="c1" />);
  expect(html).toBeDefined();
});
