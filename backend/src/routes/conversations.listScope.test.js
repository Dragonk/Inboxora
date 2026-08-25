import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const routeSource = fs.readFileSync(
  path.join(process.cwd(), 'src/routes/conversations.js'),
  'utf8',
);

describe('conversation list scope contract', () => {
  it('derives visible row aggregates from scoped physical copies', () => {
    expect(routeSource).toContain('const scopedLogicalFilter');
    expect(routeSource).toContain('COUNT(DISTINCT m.logical_message_id) FILTER (WHERE m.is_read = false)');
    expect(routeSource).toContain('COALESCE(BOOL_OR(m.is_starred), false) AS is_starred');
    // Parent visibility uses scopedLogicalFilter so folder/account filtering applies
    // to the conversation parent row, not just to the preview subquery.
    expect(routeSource).toContain('${scopedLogicalFilter}');
  });

  it('scopes parent existence and aggregates by folder but keeps expanded children conversation-wide', () => {
    expect(routeSource).toContain('const folderFilter = folder ?');
    expect(routeSource).toContain('const scopedLogicalFilter');
    expect(routeSource).toContain("const scopedPreviewFilter = `${accountId ? 'AND m.account_id = $2' : ''}`;");
    // scopedLogicalFilter and scopedPreviewFilter must NOT reference folderParam
    // (folder scoping is via folderFilter / scopedPreviewOrder, not via the account filter).
    // scopedLogicalFilter and scopedPreviewFilter definitions must NOT reference folderParam
    // (folder scoping is via folderFilter / scopedPreviewOrder, not via the account filter).
    const logicalFilterLine = routeSource.split('\n').find(l => l.includes('const scopedLogicalFilter'));
    const previewFilterLine = routeSource.split('\n').find(l => l.includes('const scopedPreviewFilter'));
    expect(logicalFilterLine).toBeDefined();
    expect(previewFilterLine).toBeDefined();
    expect(logicalFilterLine).not.toMatch(/folderParam/);
    expect(previewFilterLine).not.toMatch(/folderParam/);
    expect(routeSource).toContain('const scopedPreviewOrder = folder ?');
    expect(routeSource).toContain('ORDER BY ${scopedPreviewOrder} m.is_read ASC');
  });
});
