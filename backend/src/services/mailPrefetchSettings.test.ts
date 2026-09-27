import { describe,expect,it,vi } from 'vitest';
import { DEFAULT_MAIL_PREFETCH_LIMIT, MAX_MAIL_PREFETCH_LIMIT, parseMailPrefetchLimit, storedMailPrefetchLimit, readMailPrefetchLimit } from './mailPrefetchSettings.js';
import { mockPoolClient } from '../test/poolClient.js';

describe('administrator prefetch limit',()=>{
  it('defaults to 25 with an explicit upper bound of 100',()=>{
    expect(DEFAULT_MAIL_PREFETCH_LIMIT).toBe(25);expect(MAX_MAIL_PREFETCH_LIMIT).toBe(100);
    expect(storedMailPrefetchLimit(undefined)).toBe(25);
  });
  it.each([0,1,20,25,30,100,'0','20','25','30','100'])('accepts exact bounded integers: %s',value=>{
    expect(parseMailPrefetchLimit(value)).toBe(Number(value));
  });
  it.each([-1,101,1.5,NaN,Infinity,null,true,false,{},[],undefined,'',' 25','25 ','25.5','25oops','1e2','00','1000'])('rejects invalid values: %s',value=>{
    expect(parseMailPrefetchLimit(value)).toBeNull();
    if(value!==undefined)expect(storedMailPrefetchLimit(value)).toBe(0);
  });
  it('reads committed settings again for each batch and honors the environment kill switch',async()=>{
    const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{value:'30'}]}).mockResolvedValueOnce({rows:[{value:'0'}]});
    const client=mockPoolClient({query});
    expect(await readMailPrefetchLimit(client,{})).toBe(25);
    expect(await readMailPrefetchLimit(client,{})).toBe(30);
    expect(await readMailPrefetchLimit(client,{})).toBe(0);
    expect(await readMailPrefetchLimit(client,{MAIL_BODY_PREFETCH:'off'})).toBe(0);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('does not fall back to speculative reads when the settings query fails',async()=>{
    const client=mockPoolClient({query:vi.fn().mockRejectedValue(new Error('DB down'))});
    await expect(readMailPrefetchLimit(client,{})).rejects.toThrow('DB down');
  });
});
