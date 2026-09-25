import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const persistence = readFileSync(new URL('./conversationPersistence.ts', import.meta.url), 'utf8');
const database = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
const rebuild = readFileSync(new URL('./conversationRebuild.ts', import.meta.url), 'utf8');

describe('conversation storage/concurrency regression', () => {
  it('does not duplicate complete raw header blocks into logical_messages', () => {
    expect(persistence).not.toMatch(/INSERT INTO logical_messages[^\n]*\braw_headers\b/);
    expect(persistence).not.toMatch(/UPDATE logical_messages SET[^\n]*\braw_headers\b/);
    expect(persistence).toMatch(/headerFingerprint: createHash\('sha256'\)/);
  });

  it('serializes live writes by account before SERIALIZABLE begins', () => {
    expect(persistence).toMatch(/serializeKey: conversationSerializeKey\(effectiveUserId, accountId\)/);
    const lock = database.indexOf("pg_advisory_lock(hashtext($1), hashtext($2))");
    const begin = database.indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(begin).toBeGreaterThan(lock);
  });

  it('makes rebuild share the live-account lock', () => {
    expect(rebuild).toMatch(/const liveLockKey = conversationSerializeKey\(userId, accountId\)/);
    expect(rebuild).toMatch(/pg_advisory_lock\(hashtext\(\$1\), hashtext\(\$2\)\).*liveLockKey/s);
  });
});
