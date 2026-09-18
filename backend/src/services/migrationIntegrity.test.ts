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
    const source = readFileSync(join(process.cwd(), 'src/services/migrations.ts'), 'utf8');
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

  it('creates a tenant-scoped push device registry with unique per-user device ids', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0084_push_devices.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS push_devices');
    expect(sql).toContain('user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE');
    expect(sql).toContain('UNIQUE (user_id, device_id)');
    expect(sql).toContain('push_devices_user_active_idx');
    expect(sql).toContain('push_devices_token_prefix_idx');
    expect(sql).toContain('push_devices_last_seen_idx');
  });

  it('adds owner-token invitation outbox claims for overlap-safe delivery', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0085_calendar_invitation_outbox_claim.sql'), 'utf8');
    expect(sql).toContain("'processing'");
    expect(sql).toContain('claim_token UUID');
    expect(sql).toContain('claim_expires_at TIMESTAMPTZ');
    expect(sql).toContain('calendar_invitation_outbox_claim_idx');
  });

  it('preserves invitation retries when their event is deleted', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0086_calendar_invitation_outbox_deleted_event.sql'), 'utf8');
    expect(sql).toContain('ALTER COLUMN event_id DROP NOT NULL');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS calendar_invitation_outbox_event_id_fkey');
    expect(sql).toContain('REFERENCES calendar_events(id) ON DELETE SET NULL');
  });

  it('marks recoverable final invitation checkpoints in migration 0088', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0088_calendar_invitation_outbox_completion_checkpoint.sql'), 'utf8');
    expect(sql).toContain('completion_checkpointed_at TIMESTAMPTZ');
    expect(sql).toContain('calendar_invitation_outbox_completion_checkpoint_idx');
  });

  it('persists uncertain invitation dispatches before SMTP', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0089_calendar_invitation_outbox_uncertain_dispatch.sql'), 'utf8');
    expect(sql).toContain("'uncertain'");
    expect(sql).toContain('dispatch_action JSONB');
    expect(sql).toContain('dispatch_started_at TIMESTAMPTZ');
    expect(sql).toContain('calendar_invitation_outbox_uncertain_dispatch_idx');
  });

  it('keeps the current cancellation outbox reference with its calendar event', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0090_calendar_cancellation_outbox_reference.sql'), 'utf8');
    expect(sql).toContain('cancellation_outbox_id UUID');
    expect(sql).toContain('REFERENCES calendar_invitation_outbox(id) ON DELETE SET NULL');
    expect(sql).toContain('calendar_events_cancellation_outbox_idx');
  });

  it('stores historical UIDVALIDITY for destructive draft identity checks', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0091_draft_uidvalidity_identity.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS draft_uid_validity BIGINT');
    expect(sql).toContain('messages_draft_identity_idx');
  });

  it('preserves editable draft composition and reply metadata', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0093_draft_composition_metadata.sql'), 'utf8');
    expect(sql).toContain('draft_alias_id UUID');
    expect(sql).toContain('draft_in_reply_to TEXT');
    expect(sql).toContain('draft_composition JSONB');
  });

  it('retains private BCC recipients for persisted drafts', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0092_draft_bcc_addresses.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS draft_bcc_addresses JSONB');
  });

  it('creates durable tenant-scoped send idempotency intents', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0087_send_idempotency.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS send_idempotency');
    expect(sql).toContain('REFERENCES users(id) ON DELETE CASCADE');
    expect(sql).toContain('PRIMARY KEY (user_id, idempotency_key)');
    expect(sql).toContain("'pending', 'uncertain', 'completed'");
    expect(sql).toContain('send_idempotency_reconciliation_idx');
  });

  it('adds a partial logical-message lookup index for non-deleted physical copies', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0060_conversation_logical_message_lookup_index.sql'), 'utf8');
    expect(sql).toContain('ON messages(logical_message_id, date DESC NULLS LAST, id DESC)');
    expect(sql).toContain('WHERE is_deleted = false AND logical_message_id IS NOT NULL');
  });

  it('stores the STATUS UIDNEXT watermark for folder freshness', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0094_folder_uidnext_status.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS uid_next BIGINT');
  });

  it('creates the per-user antispam classifier schema', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0095_spam_classifier_v2.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS spam_models');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS token_counts');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS antispam_enabled BOOLEAN NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS trusted_authserv_id VARCHAR(255)');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS spam_training_deletions');
  });

  it('creates the per-account maintenance state table for one-time repairs', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0096_account_maintenance_state.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS account_maintenance_state');
    expect(sql).toContain('PRIMARY KEY (account_id, key)');
    expect(sql).toContain('REFERENCES email_accounts(id) ON DELETE CASCADE');
  });

  it('adds distinct-message maturity counters to the spam model', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0097_spam_model_usable_counts.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS usable_spam BIGINT NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS usable_ham BIGINT NOT NULL DEFAULT 0');
  });

  it('adds a stable training identity to the spam training log', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0098_spam_training_identity.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS training_identity TEXT');
    expect(sql).toContain('idx_spam_training_log_user_identity');
    expect(sql).toContain("'mid:'");
    expect(sql).toContain("'copy:'");
  });

  it('applies one normalization rule for identities in SQL and TypeScript', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0098_spam_training_identity.sql'), 'utf8');
    // Collapse whitespace + lowercase + trim, exactly like trainingIdentityFor.
    expect(sql).toContain("regexp_replace(lower(COALESCE");
    expect(sql).toContain("'\\s+', ' ', 'g'");
  });

  it('re-derives identities for databases that applied the first 0098 revision', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0099_spam_identity_rederivation.sql'), 'utf8');
    expect(sql).toContain('UPDATE spam_training_log');
    expect(sql).toContain('idx_spam_training_log_user_identity');
  });

  it('stores the final blended antispam score alongside the ML probability', () => {
    const sql = readFileSync(join(process.cwd(), 'migrations/0100_message_spam_score_blended.sql'), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS spam_score_blended FLOAT');
  });

  it('accepts the replaced unreleased 0098 checksum so applied dev databases keep booting', () => {
    const source = readFileSync(join(process.cwd(), 'src/services/migrations.ts'), 'utf8');
    expect(source).toContain('0098_spam_training_identity');
    expect(source).toContain('82716d8414acd5f2a26fad940165827df0e48cc676a38ac20fd1a96ccb5b0ded');
  });
});
