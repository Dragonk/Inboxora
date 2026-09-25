import { describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ withTransaction: vi.fn() }));
const fence = vi.hoisted(() => ({ record: vi.fn() }));
const google = vi.hoisted(() => ({ ensure: vi.fn() }));
const graph = vi.hoisted(() => ({ ensure: vi.fn() }));
vi.mock('./db.js', () => ({ withTransaction: db.withTransaction }));
vi.mock('./calendarCollectionFence.js', () => ({ recordCalendarDeletionFence: fence.record }));
vi.mock('./providers/google/googleCalendarSync.js', () => ({ ensureGoogleCalendarCollection: google.ensure }));
vi.mock('./providers/microsoft/graphCalendarSync.js', () => ({ ensureGraphCalendarCollection: graph.ensure }));
import { projectCalendarCollection } from './calendarCollectionProjection.js';
const input = { operationId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',accountId:'00000000-0000-4000-8000-000000000003',connectionId:'00000000-0000-4000-8000-000000000004',value:{provider:'google' as const,action:'delete' as const,remoteCalendarId:'remote',name:null} };

describe('calendar collection projection', () => {
  it('fences before disabling/unlinking and deleting local event projection', async () => {
    const calls:string[]=[];
    const client={ query: vi.fn(async (sql:string) => { calls.push(sql); if(sql.startsWith('SELECT id,local_calendar_id')) return {rows:[{id:'collection',local_calendar_id:'calendar'}]}; return {rows:[]}; }) };
    db.withTransaction.mockImplementationOnce(async (fn:(value:typeof client)=>unknown)=>fn(client));
    fence.record.mockImplementationOnce(async()=>{ calls.push('fence'); });
    const result=await projectCalendarCollection(input);
    expect(result).toEqual({state:'projected',collectionId:'collection',localCalendarId:'calendar'});
    expect(calls.indexOf('fence')).toBeLessThan(calls.findIndex(sql=>sql.startsWith('UPDATE integration_collections')));
    expect(calls.some(sql=>sql.startsWith('DELETE FROM calendars'))).toBe(true);
  });
  it('keeps a failed local projection pending after the remote operation is confirmed', async () => {
    db.withTransaction.mockImplementationOnce(async()=>{ throw new Error('projection failed'); });
    await expect(projectCalendarCollection(input)).resolves.toEqual({state:'pending',collectionId:null,localCalendarId:null});
  });
});
