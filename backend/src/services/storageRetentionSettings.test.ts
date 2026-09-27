import {describe,it,expect,vi} from 'vitest';
import {parseRetentionPatch,parseRetentionValue,readStorageRetentionPolicy,RETENTION_KEYS,STORAGE_RETENTION_FIELDS} from './storageRetentionSettings.js';
import {mockPoolClient} from '../test/poolClient.js';
describe('strict global retention settings',()=>{
  it('returns the documented defaults only for absent fields',async()=>{
    const result=await readStorageRetentionPolicy(mockPoolClient({query:vi.fn().mockResolvedValue({rows:[]})}));
    expect(result).toEqual(Object.fromEntries(RETENTION_KEYS.map(k=>[k,STORAGE_RETENTION_FIELDS[k].default])));
    expect(result.mail_body_cache_days).toBe(30);
  });
  it('accepts atomic partial patches and preserves zero as no cache expiration',()=>{
    expect(parseRetentionPatch({mail_body_cache_days:0,dav_history_days:'7'})).toEqual({mail_body_cache_days:0,dav_history_days:7});
    expect(parseRetentionPatch({mail_body_cache_days:3650,dav_history_max_entries:100000})).toEqual({mail_body_cache_days:3650,dav_history_max_entries:100000});
  });
  it.each([null,[],{},true,{extra:1},{mail_body_cache_days:3651},{mail_body_cache_days:1.5},{mail_body_cache_days:'7days'},
    {mail_body_cache_days:null},{dav_history_days:0},{dav_history_max_entries:99},{auth_log_days:0}])('rejects malformed or out-of-range patches %j',value=>{
    expect(()=>parseRetentionPatch(value)).toThrow();
  });
  it('refuses corrupt stored policy instead of guessing an aggressive deletion cutoff',async()=>{
    const client=mockPoolClient({query:vi.fn().mockResolvedValue({rows:[{key:'auth_log_days',value:'bad'}]})});
    await expect(readStorageRetentionPolicy(client)).rejects.toThrow('Invalid stored retention');
  });
  it.each(['',' 7','7 ','1e2','01',NaN,Infinity,false])('rejects noncanonical values %s',v=>{
    expect(parseRetentionValue('mail_body_cache_days',v)).toBeNull();
  });
});
