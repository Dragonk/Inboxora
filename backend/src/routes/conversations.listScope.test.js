import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'src/routes/conversations.js'),
  'utf8',
);

describe('conversation list scope contract', () => {
  it('derives visible row aggregates from scoped physical copies', () => {
    expect(routeSource).toContain('const scopedMessageFilter');
    expect(routeSource).toContain('const scopedLogicalFilter');
    expect(routeSource).toContain('COUNT(DISTINCT m.logical_message_id) FILTER (WHERE m.is_read = false)');
    expect(routeSource).toContain('COALESCE(BOOL_OR(m.is_starred), false) AS is_starred');
    expect(routeSource).toContain('JOIN messages m ON m.conversation_id = c.id AND m.is_deleted = false ${scopedMessageFilter}');
    expect(routeSource).toContain('WHERE m.conversation_id = c.id AND m.is_deleted = false ${scopedMessageFilter}');
  });

  it('scopes parent existence and aggregates by folder but keeps expanded children conversation-wide', () => {
    expect(routeSource).toContain('const folderFilter = folder ?');
    expect(routeSource).toContain('const scopedMessageFilter');
    expect(routeSource).toContain("const scopedLogicalFilter = `${accountId ? 'AND visible_lm.account_id = $2' : ''}`;");
    expect(routeSource).toContain("const scopedPreviewFilter = `${accountId ? 'AND m.account_id = $2' : ''}`;");
    expect(routeSource).not.toMatch(/const scopedLogicalFilter[\s\S]*?folderParam/);
    expect(routeSource).not.toMatch(/const scopedPreviewFilter[\s\S]*?folderParam/);
    expect(routeSource).toContain('const scopedPreviewOrder = folder ?');
    expect(routeSource).toContain('ORDER BY ${scopedPreviewOrder} m.is_read ASC');
  });
});
