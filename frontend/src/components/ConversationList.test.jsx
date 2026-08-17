import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationList from './ConversationList.jsx';

it('renders the conversation list component', () => {
  const html = renderToStaticMarkup(<ConversationList params={{}} />);
  expect(html).toBeDefined();
});
