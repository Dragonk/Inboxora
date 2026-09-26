import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({post:vi.fn(),get:vi.fn()}));
vi.mock('./graphApiClient.js',async importOriginal=>({
  ...await importOriginal<typeof import('./graphApiClient.js')>(),
  graphPost:mocks.post,graphGetWithHeaders:mocks.get,
}));
import { GraphApiError } from './graphApiClient.js';
import { readGraphStableLocation, singleConvertedId } from './graphStableLocation.js';
import { graphDeltaFields,graphHasEnvelope } from './graphDeltaFields.js';
const api={userId:'user-1',connectionId:'connection-1',immutableIds:false};
const conversion=(sourceId:string,targetId:string)=>({value:[{sourceId,targetId}]});
beforeEach(()=>vi.resetAllMocks());

describe('Graph physical identity, not RFC identity',()=>{
  it('finds the same immutable object after its REST id changes',async()=>{
    mocks.post.mockResolvedValueOnce(conversion('old','stable')).mockResolvedValueOnce(conversion('stable','new'));
    mocks.get.mockResolvedValue({id:'stable',parentFolderId:'inbox'});
    await expect(readGraphStableLocation(api,'old')).resolves.toEqual({kind:'found',id:'new',parentFolderId:'inbox',immutableId:'stable'});
    expect(mocks.get.mock.calls[0]?.[0]).toMatchObject({immutableIds:true});
    expect(String(mocks.get.mock.calls[0]?.[1])).toContain('/me/messages/stable');
    expect(mocks.get.mock.calls.some(call=>String(call[1]).includes('internetMessageId'))).toBe(false);
  });
  it('classifies absence only after a successful identity conversion and stable GET 404',async()=>{
    mocks.post.mockResolvedValue(conversion('old','stable'));
    mocks.get.mockRejectedValue(new GraphApiError({code:'RESOURCE_NOT_FOUND',status:404,message:'gone'}));
    await expect(readGraphStableLocation(api,'old')).resolves.toEqual({kind:'gone',immutableId:'stable'});
  });
  it('never turns a conversion 404 into a missing message',async()=>{
    mocks.post.mockRejectedValue(new GraphApiError({code:'RESOURCE_NOT_FOUND',status:404,message:'conversion failed'}));
    await expect(readGraphStableLocation(api,'old')).rejects.toMatchObject({status:404});
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('never turns reverse-conversion failure AFTER a successful GET into deletion',async()=>{
    mocks.post.mockResolvedValueOnce(conversion('old','stable')).mockRejectedValueOnce(new GraphApiError({code:'RESOURCE_NOT_FOUND',status:404,message:'conversion failed'}));
    mocks.get.mockResolvedValue({id:'stable',parentFolderId:'inbox'});
    await expect(readGraphStableLocation(api,'old')).rejects.toMatchObject({status:404});
  });
  it('rejects malformed successful location responses',async()=>{
    mocks.post.mockResolvedValue(conversion('old','stable'));mocks.get.mockResolvedValue({parentFolderId:'inbox'});
    await expect(readGraphStableLocation(api,'old')).rejects.toThrow('invalid stable message location');
  });
  it('does not let a connection flag authorize an old-format row',async()=>{
    mocks.post.mockResolvedValueOnce(conversion('old-format','rest')).mockResolvedValueOnce(conversion('rest','different-stable-id'));
    await expect(readGraphStableLocation({...api,immutableIds:true},'old-format')).rejects.toThrow('does not match');
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('propagates throttling without another request',async()=>{
    mocks.post.mockRejectedValue(new GraphApiError({code:'RATE_LIMITED',status:429,message:'wait',retryAfterSeconds:90}));
    await expect(readGraphStableLocation(api,'old')).rejects.toMatchObject({code:'RATE_LIMITED',retryAfterSeconds:90});
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('rejects incomplete or conflicting conversion evidence',()=>{
    expect(()=>singleConvertedId('a',null)).toThrow();
    expect(()=>singleConvertedId('a',{value:[]})).toThrow();
    expect(()=>singleConvertedId('a',{value:[{sourceId:'A',targetId:'b'}]})).toThrow();
    expect(()=>singleConvertedId('a',{value:[{sourceId:'a',targetId:'b'},{sourceId:'a',targetId:'c'}]})).toThrow();
  });
});

describe('sparse Graph field masks',()=>{
  it('preserves explicit false, empty and null while excluding omission/undefined',()=>{
    expect(graphDeltaFields({id:'m',isRead:false,subject:'',bodyPreview:null,from:undefined}))
      .toEqual(['id','isRead','subject','bodyPreview']);
  });
  it('does not mistake an id and read flag for an envelope',()=>{
    expect(graphHasEnvelope({})).toBe(false);
    expect(graphHasEnvelope({internetMessageId:'<message@test>'})).toBe(true);
  });
});
