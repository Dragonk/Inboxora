import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('storage worker startup wiring',()=>{
  const source=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
  it('loads dotenv before the new service can initialize the DB pool',()=>{
    expect(source.indexOf("import 'dotenv/config'")).toBeLessThan(source.indexOf("from './services/storageMaintenance.js'"));
  });
  it('starts after migrations and the HTTP listener, and stops on graceful shutdown',()=>{
    const listen=source.indexOf('httpServer.listen(PORT');
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
