import { describe, expect, it } from 'vitest';
import { parseClientCredentials } from './clientAuthentication.js';
const basic=(value:string)=>'Basic '+Buffer.from(value).toString('base64');
describe('OAuth client credential parsing',()=>{
  it('decodes form-escaped Basic credentials and accepts a matching body client ID',()=>{
    expect(parseClientCredentials(basic('client%3Aone:s%2Becret+value'),{client_id:'client:one'}))
      .toEqual({clientId:'client:one',clientSecret:'s+ecret value',method:'client_secret_basic'});
  });
  it('supports public and secret-post requests without Basic',()=>{
    expect(parseClientCredentials(undefined,{client_id:'client'}).method).toBe('none');
    expect(parseClientCredentials(undefined,{client_id:'client',client_secret:'secret'})).toEqual({clientId:'client',clientSecret:'secret',method:'client_secret_post'});
  });
  it.each([[basic('client:secret'),{client_id:'other'}],[basic('client:secret'),{client_secret:'secret'}],
    ['Bearer secret',{}],['Basic not*base64',{}],[basic('missing-separator'),{}],[basic('client:%ZZ'),{}],
    [basic('client:'),{}],[undefined,{client_id:['a','b']}],[undefined,{client_id:'client',client_secret:42}]])('rejects mixed, conflicting or malformed credentials %#',(header,body)=>{
    expect(()=>parseClientCredentials(header as string|undefined,body)).toThrow();
  });
});
