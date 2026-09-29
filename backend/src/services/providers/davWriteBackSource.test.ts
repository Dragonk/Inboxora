import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, decrypt, getConnectionPolicy } = vi.hoisted(() => ({
  query: vi.fn(),
  decrypt: vi.fn((value: unknown) => { if (typeof value !== 'string') throw new TypeError('Encrypted credential must be a string'); return value; }),
  getConnectionPolicy: vi.fn(),
}));

vi.mock('../db.js', () => ({ query }));
vi.mock('../encryption.js', () => ({ decrypt }));
vi.mock('../connectionPolicy.js', () => ({ getConnectionPolicy }));

import { resolveDavSource } from './davWriteBack.js';

describe('CardDAV source credential isolation', () => {
  beforeEach(() => {
    query.mockReset();
    decrypt.mockClear();
    getConnectionPolicy.mockReset();
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
  });

  it('resolves a book through its own integration rather than another CardDAV row', async () => {
    query.mockResolvedValue({ rows: [{
      collection_url: 'https://dav-b.example/addressbooks/team/',
      config: { username: 'user-b', password: 'secret-b' },
    }] });

    await expect(resolveDavSource({
      kind: 'carddav', userId: 'user-1', externalUrl: 'https://dav-b.example/addressbooks/team/', localCollectionId: 'book-b',
    })).resolves.toMatchObject({
      kind: 'carddav', collectionUrl: 'https://dav-b.example/addressbooks/team/', username: 'user-b', password: 'secret-b',
    });

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('JOIN source_connections sc ON sc.id = ic.source_connection_id');
    expect(String(sql)).toContain('JOIN user_integrations ui ON ui.id = sc.integration_id');
    expect(String(sql)).toContain('(ic.id = $2 OR ic.local_address_book_id = $2)');
    expect(params).toEqual(['user-1', 'book-b']);
    expect(decrypt).toHaveBeenCalledWith('secret-b');
    expect(decrypt).not.toHaveBeenCalledWith('secret-a');
  });

  it.each([undefined, null, {}, 42])('refuses a malformed stored credential (%s) without calling decryption', async password => {
    query.mockResolvedValue({ rows: [{ collection_url: 'https://dav.example.test/books/', config: { username: 'owner', password } }] });
    await expect(resolveDavSource({ kind: 'carddav', userId: 'user-1', externalUrl: null, localCollectionId: 'book-1' })).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('refuses a missing legacy integration without a decryption error', async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(resolveDavSource({ kind: 'carddav', userId: 'user-1', externalUrl: 'https://dav.example.test/books/' })).resolves.toBeNull();
    expect(query).toHaveBeenCalledOnce();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('refuses an unlinked book instead of falling back to another source credentials', async () => {
    query.mockResolvedValue({ rows: [] });

    await expect(resolveDavSource({
      kind: 'carddav', userId: 'user-1', externalUrl: 'https://dav-b.example/addressbooks/team/', localCollectionId: 'book-b',
    })).resolves.toBeNull();

    expect(query).toHaveBeenCalledOnce();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
