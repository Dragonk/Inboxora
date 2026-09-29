import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request:vi.fn(), policy:vi.fn(), validateHost:vi.fn() }));
vi.mock('./davCollectionClient.js',async importOriginal=>({ ...(await importOriginal<typeof import('./davCollectionClient.js')>()), davCollectionRequest:mocks.request }));
vi.mock('./connectionPolicy.js',()=>({getConnectionPolicy:mocks.policy}));
vi.mock('./hostValidation.js',async importOriginal=>({...(await importOriginal<typeof import('./hostValidation.js')>()),validateHost:mocks.validateHost}));
import { discoverDavAccount } from './davDiscovery.js';
const credentials={serverUrl:'https://dav.example.test/dav/',username:'owner',password:'private-secret'};
function multistatus(href:string,properties:string,children='') {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav">
    <d:response><d:href>${href}</d:href><d:propstat><d:prop>${properties}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>${children}</d:multistatus>`;
}
function server(calendars=true,contacts=true,empty=false) {
  mocks.request.mockImplementation(async (target:{url:string}, request:RequestInit)=>{
    const path=new URL(target.url).pathname;
    const requested=String(request.body);const calendar=requested.includes('calendar-home-set');
    if(path==='/dav/'||path==='/dav/principal/') {
      const supported=calendar?calendars:contacts;
      const home=calendar?'<c:calendar-home-set><d:href>/dav/calendars/</d:href></c:calendar-home-set>':'<a:addressbook-home-set><d:href>/dav/books/</d:href></a:addressbook-home-set>';
      return new Response(multistatus(path,`<d:current-user-principal><d:href>/dav/principal/</d:href></d:current-user-principal><d:resourcetype><d:collection/></d:resourcetype>${supported?home:''}`),{status:207});
    }
    if(path==='/dav/calendars/'||path==='/dav/books/') {
      const type=path==='/dav/calendars/'?'c:calendar':'a:addressbook';
      const resource=empty?'':`<d:response><d:href>${path}private/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><${type}/></d:resourcetype><d:displayname>Private</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      return new Response(multistatus(path,'<d:resourcetype><d:collection/></d:resourcetype>',resource),{status:207});
    }
    return new Response('',{status:404});
  });
}
beforeEach(()=>{vi.resetAllMocks();mocks.policy.mockResolvedValue({allowPrivateHosts:false});mocks.validateHost.mockResolvedValue(null);});
describe('read-only DAV capability discovery',()=>{
  it.each([[true,true],[true,false],[false,true]])('detects calendars=%s, contacts=%s independently',async(calendars,contacts)=>{
    server(calendars,contacts);const result=await discoverDavAccount(credentials);
    expect(Boolean(result.calendars)).toBe(calendars);expect(Boolean(result.contacts)).toBe(contacts);
    for(const snapshot of [result.calendars,result.contacts])if(snapshot)expect(snapshot.collections).toHaveLength(1);
    expect(mocks.request.mock.calls.every(call=>call[1].method==='PROPFIND')).toBe(true);
  });
  it('keeps a supported but empty service available',async()=>{
    server(true,true,true);const result=await discoverDavAccount(credentials);
    expect(result.calendars?.collections).toEqual([]);expect(result.contacts?.collections).toEqual([]);
  });
  it('does not report authentication or transport failure as an unsupported service',async()=>{
    mocks.request.mockResolvedValue(new Response('',{status:401}));
    await expect(discoverDavAccount(credentials)).rejects.toMatchObject({code:'DAV_AUTH_FAILED'});
    mocks.request.mockRejectedValue(new Error('connection lost'));
    await expect(discoverDavAccount(credentials)).rejects.toMatchObject({code:'DAV_DISCOVERY_FAILED',status:502});
  });
  it('fails closed on a truncated or invalid multistatus',async()=>{
    mocks.request.mockResolvedValue(new Response('<d:multistatus xmlns:d="DAV:"><d:response>',{status:207}));
    await expect(discoverDavAccount(credentials)).rejects.toMatchObject({code:'DAV_DISCOVERY_FAILED'});
  });
  it('does not send credentials to invalid, blocked or public plaintext addresses',async()=>{
    for(const serverUrl of ['javascript:alert(1)','https://name:password@example.test/','https://example.test/?token=secret']) {
      await expect(discoverDavAccount({...credentials,serverUrl})).rejects.toMatchObject({code:'DAV_INVALID_URL'});
    }
    await expect(discoverDavAccount({...credentials,serverUrl:'http://public.example.test/'})).rejects.toMatchObject({code:'DAV_HTTPS_REQUIRED'});
    mocks.policy.mockResolvedValue({allowPrivateHosts:true});
    await expect(discoverDavAccount({...credentials,serverUrl:'http://public.example.test/'})).rejects.toMatchObject({code:'DAV_HTTPS_REQUIRED'});
    mocks.validateHost.mockResolvedValue('blocked');
    await expect(discoverDavAccount(credentials)).rejects.toMatchObject({code:'DAV_HOST_BLOCKED'});
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

it('discovers a second service through its well-known endpoint even when the entered root has another principal', async () => {
  server(true, false);
  const primary = mocks.request.getMockImplementation();
  if (!primary) throw new Error('Missing fixture handler');
  mocks.request.mockImplementation(async (target: { url: string }, request: RequestInit) => {
    if (new URL(target.url).pathname === '/.well-known/carddav') {
      return new Response(multistatus('/.well-known/carddav',
        '<d:resourcetype><d:collection/></d:resourcetype><a:addressbook-home-set><d:href>/dav/books/</d:href></a:addressbook-home-set>'), { status: 207 });
    }
    return primary(target, request);
  });
  const result = await discoverDavAccount(credentials);
  expect(result.calendars?.collections).toHaveLength(1);
  expect(result.contacts?.collections).toHaveLength(1);
  expect(mocks.request.mock.calls.some(call => new URL(call[0].url).pathname === '/.well-known/carddav')).toBe(true);
});
