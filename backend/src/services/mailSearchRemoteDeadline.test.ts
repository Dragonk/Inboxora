import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js',()=>({query:vi.fn(),withTransaction:vi.fn()}));
vi.mock('./providers/microsoft/graphMailSearch.js',()=>({ingestGraphMailSearch:vi.fn()}));
vi.mock('./providers/google/gmailMailSearch.js',()=>({ingestGmailMailSearch:vi.fn()}));
import { waitForRemoteSearch, type RemoteSearchResult } from './mailSearchRemote.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('shared remote search response deadline',()=>{
  it('preserves a result received in the request budget',async()=>{
    const result={rowIds:['owned-message'],truncated:false};
    expect(await waitForRemoteSearch(async()=>result,Date.now()+8000)).toBe(result);
  });
  it('does not start another queued provider after the request deadline',async()=>{
    const run=vi.fn();
    expect(await waitForRemoteSearch(run,Date.now()-1)).toMatchObject({rowIds:[],truncated:true});
    expect(run).not.toHaveBeenCalled();
  });
  it('returns local-only coverage on expiry and never mutates it with a late result',async()=>{
    vi.useFakeTimers();
    let finish!: (value:RemoteSearchResult)=>void;
    const response=waitForRemoteSearch(()=>new Promise(resolve=>{finish=resolve;}),Date.now()+8000);
    await vi.advanceTimersByTimeAsync(8000);
    const partial=await response;
    expect(partial).toMatchObject({rowIds:[],truncated:true,coverageIncomplete:true,retryable:true,errors:[expect.stringContaining('deadline')]});
    finish({rowIds:['late-match'],truncated:false});
    await vi.advanceTimersByTimeAsync(1);
    expect(partial.rowIds).toEqual([]);
  });
  it('preserves provider errors that arrive before the deadline',async()=>{
    await expect(waitForRemoteSearch(async()=>{throw new Error('provider unavailable');},Date.now()+8000)).rejects.toThrow('provider unavailable');
  });
});
