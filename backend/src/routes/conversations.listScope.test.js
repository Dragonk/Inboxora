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

  it('applies folder scope to logical-message visibility and previews', () => {
    expect(routeSource).toContain('visible_lm.folder = $${folderParam}');
    expect(routeSource).toContain('m.folder = $${folderParam}');
    expect(routeSource).toContain('const folderFilter = folder ?');
  });
});
