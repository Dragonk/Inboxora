import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('migration integrity', () => {
  it('keeps historical 0002 byte-identical to upstream checkout', () => {
    const current = readFileSync(join(process.cwd(), 'migrations/0002_subject_threading.sql'));
    expect(createHash('sha256').update(current).digest('hex')).toBe('b38fc30e6626f4e8a75819263b31531945a164f36e6a86f1ce0d301b3b421116');
  });

  it('contains tenant composite constraints in the repair migration', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0055_conversation_tenant_constraints.sql'), 'utf8');
    expect(sql).toContain('fk_logical_conversation_owner');
    expect(sql).toContain('fk_provider_mapping_conversation_owner');
    expect(sql).toContain('fk_message_conversation_owner');
  });

  it('records migration checksums in the runner', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/migrations.js'), 'utf8');
    expect(source).toContain('sha256');
    expect(source).toContain('Migration checksum mismatch');
  });

  it('adds a partial logical-message lookup index for non-deleted physical copies', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0060_conversation_logical_message_lookup_index.sql'), 'utf8');
    expect(sql).toContain('ON messages(logical_message_id, date DESC NULLS LAST, id DESC)');
    expect(sql).toContain('WHERE is_deleted = false AND logical_message_id IS NOT NULL');
  });
});
