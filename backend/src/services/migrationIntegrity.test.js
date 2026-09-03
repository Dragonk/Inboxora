import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
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

  it('adds the labelled contact-date projection for CardDAV round-trips', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0074_contact_dates_multi.sql'), 'utf8');
    expect(sql).toContain('contact_dates JSONB NOT NULL DEFAULT');
    expect(sql).toContain("'Birthday'");
    expect(sql).toContain("'Anniversary'");
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

  it('migrates calendar source URLs to user-scoped fingerprints before encryption', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0072_calendar_source_url_secrets.sql'), 'utf8');
    expect(createHash('sha256').update(sql).digest('hex')).toBe('b780dd8872d45ae32ea93a5ee34e67747de64bffb92f89b85616acc07e5bdce1');
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    expect(sql).toContain("digest(url, 'sha256')");
    expect(sql).toContain('calendar_source_url_fingerprint_trigger');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS calendar_import_sources_user_id_url_key');
    expect(sql).toContain('calendar_import_sources_user_url_fingerprint_key');
    expect(sql).toContain('ALTER COLUMN url_fingerprint SET NOT NULL');
    expect(sql).toContain('Legacy writers may omit the new column');
  });

  it('installs a no-bypass plaintext URL guard in the forward repair migration', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0073_calendar_source_url_plaintext_guard.sql'), 'utf8');
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).toContain('Calendar source URLs must be encrypted before storage');
    expect(sql).toContain('NEW.url NOT LIKE \'enc:v1:%\'');
    expect(sql).toContain('CREATE TRIGGER calendar_source_url_fingerprint_trigger');
  });

  it('keeps contact-date migration identity unique after the existing 0072 migrations', () => {
    const sourceMigrations = readdirSync(join(process.cwd(), 'migrations')).filter(name => name.startsWith('0072_'));
    expect(sourceMigrations).toContain('0072_calendar_source_url_secrets.sql');
    expect(sourceMigrations).not.toContain('0072_contact_dates_multi.sql');
    expect(readFileSync(join(process.cwd(), 'migrations/0074_contact_dates_multi.sql'), 'utf8')).toContain('contact_dates JSONB NOT NULL DEFAULT');
  });

  it('adds a partial logical-message lookup index for non-deleted physical copies', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0060_conversation_logical_message_lookup_index.sql'), 'utf8');
    expect(sql).toContain('ON messages(logical_message_id, date DESC NULLS LAST, id DESC)');
    expect(sql).toContain('WHERE is_deleted = false AND logical_message_id IS NOT NULL');
  });
});
