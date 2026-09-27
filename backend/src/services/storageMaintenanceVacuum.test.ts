import type { PoolClient } from 'pg';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./db.js',()=>({pool:{},query:vi.fn()}));
vi.mock('./conversationHeaderRepair.js',()=>({repairConversationHeadersWithClient:vi.fn()}));
vi.mock('./conversationPersistence.js',()=>({conversationSerializeKey:vi.fn()}));
import { vacuumRepairedMessages } from './storageMaintenance.js';
const query=vi.fn(async (_sql: string, _params?: unknown[])=>({rows:[],rowCount:0}));
const client={query} as unknown as PoolClient;
beforeEach(()=>{query.mockReset().mockResolvedValue({rows:[],rowCount:0});vi.restoreAllMocks();});
it('uses a maintenance timeout instead of the 15-second request timeout and restores it',async()=>{
  expect(await vacuumRepairedMessages(client)).toBe(true);
  const calls=query.mock.calls.map(c=>c[0]);
  expect(calls).toContain("SET statement_timeout = '10min'");
  expect(calls).toContain('VACUUM (ANALYZE, PARALLEL 0) messages');
  expect(calls.indexOf("SET statement_timeout = '10min'")).toBeLessThan(calls.indexOf('VACUUM (ANALYZE, PARALLEL 0) messages'));
  expect(calls.at(-1)).toBe("SET statement_timeout = '15s'");
  expect(query.mock.calls.find(c=>c[0].includes('INSERT INTO storage_maintenance'))?.[1]).toEqual(['vacuum:messages','{"needed":false}',true,86400]);
});
it('records hourly retry on cancellation instead of repeatedly restarting vacuum',async()=>{
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  query.mockImplementation(async sql=>{if(sql.startsWith('VACUUM'))throw Object.assign(new Error('cancelled'),{code:'57014'});return{rows:[],rowCount:0};});
  expect(await vacuumRepairedMessages(client)).toBe(false);
  expect(query.mock.calls.find(c=>c[0].includes('INSERT INTO storage_maintenance'))?.[1]).toEqual(['vacuum:messages','{"needed":true,"last_error_code":"57014"}',false,3600]);
  expect(query.mock.calls.at(-1)?.[0]).toBe("SET statement_timeout = '15s'");
});
