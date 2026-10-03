import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<{ rows: Record<string,unknown>[]; rowCount: number }>>(),
  release: vi.fn(),
  connect: vi.fn(),
  repair: vi.fn(),
}));
vi.mock('./db.js', () => ({ pool: { connect: mocks.connect }, query: vi.fn() }));
vi.mock('./conversationHeaderRepair.js', () => ({ repairConversationHeadersWithClient: mocks.repair }));
vi.mock('./conversationPersistence.js', () => ({ conversationSerializeKey: vi.fn() }));
import { startStorageMaintenance, stopStorageMaintenance } from './storageMaintenance.js';
describe('storage worker startup wiring',()=>{
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
  it('loads dotenv before the new service can initialize the DB pool',()=>{
    expect(source).toContain("import 'dotenv/config'");
    expect(source).toContain("from './services/storageMaintenance.js'");
    expect(source.indexOf("import 'dotenv/config'")).toBeLessThan(source.indexOf("from './services/storageMaintenance.js'"));
  });
  it('starts after migrations and the HTTP listener, and stops on graceful shutdown',()=>{
    const listen=source.indexOf('httpServer.listen(PORT');
    expect(listen).toBeGreaterThanOrEqual(0);
    expect(source).toContain('await runMigrations(');
    expect(source).toContain('  startStorageMaintenance();');
    expect(source.indexOf('await runMigrations(')).toBeLessThan(listen);
    expect(source.indexOf('  startStorageMaintenance();')).toBeGreaterThan(listen);
    expect(source).toContain('await stopStorageMaintenance();');
  });
});


it('pausing data repair leaves the independent privacy-log retention scheduler active', () => {
  const source = readFileSync(new URL('./storageMaintenance.ts', import.meta.url), 'utf8');
  expect(source).toContain("const repairEnabled = env.STORAGE_MAINTENANCE_ENABLED !== 'false'");
  expect(source).toContain('repairEnabled ? runStorageMaintenancePass() : runOperationalRetentionPass()');
});


it('the scheduled paused-worker tick executes bounded auth retention without header repair', async () => {
  vi.useFakeTimers();
  mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockReset().mockImplementation(async (sql) => ({
    rows: String(sql).includes('pg_try_advisory_lock') ? [{ locked: true }] : [], rowCount: 0,
  }));
  mocks.repair.mockClear(); mocks.release.mockClear();
  try {
    startStorageMaintenance({ NODE_ENV: 'production', STORAGE_MAINTENANCE_ENABLED: 'false' });
    expect(mocks.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    const calls = mocks.query.mock.calls.map(([sql]) => String(sql));
    expect(calls.some(sql => sql.includes('DELETE FROM auth_events') && sql.includes('LIMIT $5'))).toBe(true);
    expect(calls.some(sql => sql.includes('TRUNCATE TABLE'))).toBe(false);
    expect(mocks.repair).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(true);
  } finally {
    await stopStorageMaintenance();
    vi.useRealTimers();
  }
});
