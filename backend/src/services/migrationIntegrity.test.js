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

  it('adds no-message-id race protection and tenant-safe parent edges', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0061_conversation_identity_race_and_parent_tenant.sql'), 'utf8');
    expect(sql).toContain('uq_logical_messages_user_no_message_id_fingerprint');
    expect(sql).toContain('fk_logical_parent_owner');
    expect(sql).toContain('REFERENCES logical_messages(id, user_id)');
  });


  it('adds account-bound conversation identity and graph constraints in migration 0062', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0062_conversation_account_identity.sql'), 'utf8');
    expect(sql).toContain('ALTER TABLE logical_messages ADD COLUMN IF NOT EXISTS account_id UUID');
    expect(sql).toContain('ce_lm_map');
    expect(sql).toContain('fk_logical_parent_account');
    expect(sql).toContain('uq_logical_messages_account_canonical_collision');
    expect(sql).toContain('fk_message_conversation_account');
  });

  it('records durable calendar change tombstones for incremental CalDAV sync', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0065_calendar_sync_changes.sql'), 'utf8');
    expect(sql).toContain('calendar_sync_changes');
    expect(sql).toContain("TG_OP = 'DELETE'");
    expect(sql).toContain('calendar_events_sync_change');
  });

  it('keeps invitation senders referentially intact until their events are cancelled', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0067_calendar_event_invitations.sql'), 'utf8');
    expect(sql).toContain('invite_account_id UUID REFERENCES email_accounts(id) ON DELETE RESTRICT');
  });

  it('indexes both optional contact date fields used by the virtual calendar', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0068_contact_dates.sql'), 'utf8');
    expect(sql).toContain('contacts_user_birthday_idx');
    expect(sql).toContain('contacts_user_anniversary_idx');
  });

  it('stores one durable inbound calendar projection per physical message row', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0071_inbound_calendar_invitations.sql'), 'utf8');
    expect(sql).toContain('message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE');
    expect(sql).toContain("CHECK (method IN ('REQUEST', 'CANCEL'))");
    expect(sql).toContain("(method = 'REQUEST' AND state = 'pending')");
    expect(sql).toContain("(method = 'CANCEL' AND state = 'cancelled')");
    expect(sql).toContain('sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0)');
    expect(sql).toContain('raw_ical TEXT NOT NULL CHECK (octet_length(raw_ical) <= 1048576)');
    expect(sql).toContain('parsed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(sql).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(sql).toContain('inbound_calendar_invitations_uid_idx');
    expect(sql).toContain('ON inbound_calendar_invitations (uid, recurrence_id)');
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
