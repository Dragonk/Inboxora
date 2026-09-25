import { afterEach, describe, expect, it, vi } from 'vitest';

// Two valid 32-byte keys, and the module caches the parsed key, so each case re-imports it.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const original = process.env.ENCRYPTION_KEY;

async function load(key: string | null) {
  vi.resetModules();
  if (key) process.env.ENCRYPTION_KEY = key;
  else delete process.env.ENCRYPTION_KEY;
  return await import('./encryption.js');
}

afterEach(() => {
  if (original) process.env.ENCRYPTION_KEY = original;
  else delete process.env.ENCRYPTION_KEY;
});

describe('stored credential encryption', () => {
  it('round-trips with the same key and refuses a different one', async () => {
    // RE07 rests on this: a backup restores ciphertext, and only the key that wrote it can read it back.
    const a = await load(KEY_A);
    const ciphertext = a.encrypt('s3cret-value');

    expect(ciphertext).not.toContain('s3cret-value');
    expect(a.isEncrypted(ciphertext)).toBe(true);
    expect(a.decrypt(ciphertext)).toBe('s3cret-value');

    const b = await load(KEY_B);
    // Recognisably encrypted, and unreadable — not the plaintext, and not a silent garbage string.
    expect(b.isEncrypted(ciphertext)).toBe(true);
    expect(b.decrypt(ciphertext)).toBeNull();
  });

  it('refuses to encrypt without a valid key, and never returns plaintext for junk', async () => {
    const none = await load(null);
    expect(() => none.encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    expect(none.decrypt('enc:v1:not-a-real-payload')).toBeNull();
    // A non-string is a programming error rather than unreadable data, and the module throws for it — a contract
    // worth pinning, because the callers that store credentials all pass strings.
    expect(() => none.decrypt(null)).toThrow(/must be a string/);
  });
});
