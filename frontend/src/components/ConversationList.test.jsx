import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConversationList from './ConversationList.jsx';

it('renders accessible conversation controls', () => {
  const html = renderToStaticMarkup(<ConversationList params={{}} />);
  expect(html).toContain('aria-label="Conversations"');
});
