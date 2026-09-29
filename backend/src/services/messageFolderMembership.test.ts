import { describe, expect, it } from 'vitest';
import { messageFolderMembershipSql } from './messageFolderMembership.js';

describe('indexed folder membership', () => {
  it('uses one scoped account/message set rather than a correlated label scan', () => {
    for (const scope of [{ accountIdParam: 1 }, { accountIdsParam: 1 }, { userIdParam: 1 }]) {
      const sql = messageFolderMembershipSql(scope, 2);
      expect(sql).toContain('(m.account_id, m.id) IN (');
      expect(sql).toContain('ml.folder_path = $2');
      expect(sql).toContain('UNION');
      expect(sql).not.toMatch(/\bOR\b/);
      expect(sql).not.toContain('ml.message_id = m.id');
      expect(sql).not.toContain('ml.account_id = m.account_id');
      const subquery = sql.slice(sql.indexOf('SELECT direct.'));
      expect(subquery).not.toMatch(/\bm\./);
    }
    expect(messageFolderMembershipSql({ accountIdParam: 1 })).toContain("direct.folder = 'INBOX'");
    expect(messageFolderMembershipSql({ userIdParam: 3 })).toContain('user_id = $3 AND enabled = true');
  });
  it('rejects invalid parameter indexes instead of accepting SQL fragments', () => {
    for (const index of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => messageFolderMembershipSql({ accountIdParam: index })).toThrow('Invalid mailbox query parameter');
      expect(() => messageFolderMembershipSql({ accountIdsParam: 1 }, index)).toThrow('Invalid mailbox query parameter');
    }
  });
});
