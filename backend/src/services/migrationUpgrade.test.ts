import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface MigrationRow {
  version: string;
  sha256: string;
}

interface MigrationClient {
  queries: QueryCall[];
  query: (sql: string, params?: unknown[]) => Promise<{ rows: MigrationRow[] }>;
  release: () => void;
}

const { connect, backfillRichContactFields } = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<MigrationClient>>(),
  backfillRichContactFields: vi.fn(async () => 0),
}));

vi.mock('./db.js', () => ({ pool: { connect } }));
vi.mock('./contactRichBackfill.js', () => ({ backfillRichContactFields }));

import { runMigrations } from './migrations.js';

function makeClient(applied0072Sha256 = 'b780dd8872d45ae32ea93a5ee34e67747de64bffb92f89b85616acc07e5bdce1') {
  const queries: QueryCall[] = [];
  const client: MigrationClient = {
    queries,
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql === 'SELECT version, sha256 FROM schema_migrations') {
        return { rows: [{ version: '0072_calendar_source_url_secrets', sha256: applied0072Sha256 }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  connect.mockResolvedValue(client);
  return client;
}

function insertsMigration(call: QueryCall, version: string): boolean {
  return call.sql.includes('INSERT INTO schema_migrations')
    && Array.isArray(call.params)
    && call.params[0] === version;
}

function queryAt(queries: QueryCall[], index: number): QueryCall {
  const query = queries[index];
  if (query === undefined) throw new Error(`Expected query at index ${index}`);
  return query;
}

function secondParameter(call: QueryCall): unknown {
  if (call.params === undefined) throw new Error('Expected query parameters');
  return call.params[1];
}

describe('migration upgrade safety', () => {
  beforeEach(() => {
    connect.mockReset();
    backfillRichContactFields.mockClear();
  });

  it('accepts the released 0072 checksum and executes the plaintext guard forward migration', async () => {
    const client = makeClient();
    const releasedMigration = readFileSync(join(process.cwd(), 'migrations/0072_calendar_source_url_secrets.sql'), 'utf8');
    const guardMigration = readFileSync(join(process.cwd(), 'migrations/0073_calendar_source_url_plaintext_guard.sql'), 'utf8');
    const guardSha256 = createHash('sha256').update(guardMigration).digest('hex');

    await expect(runMigrations()).resolves.toBeUndefined();

    const guardIndex = client.queries.findIndex(({ sql }) => sql.includes('Calendar source URLs must be encrypted before storage'));
    const guardRecordIndex = client.queries.findIndex(call => insertsMigration(call, '0073_calendar_source_url_plaintext_guard'));
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardRecordIndex).toBeGreaterThan(guardIndex);
    expect(client.queries.some(({ sql }) => sql === releasedMigration)).toBe(false);
    expect(secondParameter(queryAt(client.queries, guardRecordIndex))).toBe(guardSha256);
    expect(client.queries.some(({ sql }) => sql.includes('Migration checksum mismatch'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('accepts the known briefly published 0072 checksum and executes the plaintext guard forward migration', async () => {
    const client = makeClient('5ca9454166b08d0af82935dd4032510e07b1836c61fec61223c305b6608f17a4');
    const releasedMigration = readFileSync(join(process.cwd(), 'migrations/0072_calendar_source_url_secrets.sql'), 'utf8');

    await expect(runMigrations()).resolves.toBeUndefined();

    expect(client.queries.some(call => insertsMigration(call, '0073_calendar_source_url_plaintext_guard'))).toBe(true);
    expect(client.queries.some(({ sql }) => sql === releasedMigration)).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects an unrecognized 0072 checksum', async () => {
    const client = makeClient('0000000000000000000000000000000000000000000000000000');

    await expect(runMigrations()).rejects.toThrow('Migration checksum mismatch: 0072_calendar_source_url_secrets');

    expect(client.release).toHaveBeenCalledOnce();
  });
});
