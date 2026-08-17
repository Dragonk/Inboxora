import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

describe('conversation security gate', () => {
  it('requires authenticated ownership for conversation routes and sanitizes reader HTML', () => {
    const routes = readFileSync('src/routes/conversations.js', 'utf8');
    const rebuild = readFileSync('src/routes/conversationRebuild.js', 'utf8');
    expect(routes).toContain('router.use(requireAuth)');
    expect(rebuild).toContain('router.use(requireAuth)');
    const reader = readFileSync('../frontend/src/components/ConversationPane.jsx', 'utf8');
    expect(reader).toMatch(/sanitize|DOMPurify|bodyHtml/);
  });
});
