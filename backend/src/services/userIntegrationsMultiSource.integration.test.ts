import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from './db.js';

/**
 * Migration `0117`: several sources of one provider, with the single-source guarantee preserved (DAV-01).
 *
 * `user_integrations` shipped with `UNIQUE (user_id, provider)`, which made a second CardDAV or CalDAV server
 * impossible to represent at all. The constraint is replaced by two partial unique indexes, and these cases pin
 * what that means on a real database: labelled sources coexist, an unlabelled second row is still refused (so
 * every reader that expects "the" integration for a provider cannot accidentally find two), and a label is unique
 * per provider so a source can be addressed by its own name.
 */

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const userId = randomUUID();

beforeAll(async () => {
  if (!hasPg) return;
  await query("INSERT INTO users (id, username) VALUES ($1, 'multi-source') ON CONFLICT (id) DO NOTHING", [userId]);
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id = $1', [userId]);
});

/** Insert one integration row, answering whether the database accepted it. */
async function insert(provider: string, label: string | null): Promise<boolean> {
  try {
    await query(
      `INSERT INTO user_integrations (user_id, provider, config, label) VALUES ($1, $2, '{}'::jsonb, $3)`,
      [userId, provider, label],
    );
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }
}

describeOrSkip('several sources of one provider', () => {
  it('allows labelled sources beside the single unlabelled one, and refuses a second of either kind', async () => {
    await query('DELETE FROM user_integrations WHERE user_id = $1', [userId]);

    // The unlabelled row is what every existing reader expects to be alone for its provider.
    expect(await insert('carddav', null)).toBe(true);
    expect(await insert('carddav', null)).toBe(false);

    // Additional sources are addressed by their own label.
    expect(await insert('carddav', 'Work')).toBe(true);
    expect(await insert('carddav', 'Home')).toBe(true);
    expect(await insert('carddav', 'Work')).toBe(false);

    // Another provider is unaffected: its own unlabelled row and its own labels.
    expect(await insert('caldav', null)).toBe(true);
    expect(await insert('caldav', 'Work')).toBe(true);

    const rows = await query<{ provider: string; label: string | null }>(
      'SELECT provider, label FROM user_integrations WHERE user_id = $1 ORDER BY provider, label NULLS FIRST',
      [userId],
    );
    expect(rows.rows).toEqual([
      { provider: 'caldav', label: null },
      { provider: 'caldav', label: 'Work' },
      { provider: 'carddav', label: null },
      { provider: 'carddav', label: 'Home' },
      { provider: 'carddav', label: 'Work' },
    ]);
  });
});
