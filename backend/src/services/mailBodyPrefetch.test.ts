import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./db.js',()=>({pool:{connect:vi.fn()}}));
vi.mock('./providerAuthService.js',()=>({googleConfigFromEnv:()=>({}),microsoftConfigFromEnv:()=>({})}));
vi.mock('./providers/google/gmailMailBody.js',()=>({
  fetchGmailMessageContent:vi.fn(),collectGmailInlineImages:vi.fn(),embedGmailInlineImages:vi.fn(),localAttachmentsForGmail:vi.fn(()=>[]),
}));
vi.mock('./providers/microsoft/graphMailBody.js',()=>({fetchGraphMessageBody:vi.fn()}));
vi.mock('./providers/microsoft/graphMessageIdType.js',()=>({immutableIdsEnabled:vi.fn(async()=>true)}));
import { fetchGmailMessageContent, collectGmailInlineImages } from './providers/google/gmailMailBody.js';
import { fetchGraphMessageBody } from './providers/microsoft/graphMailBody.js';
import { bodyPrefetchEnabled, prefetchRetrySeconds, readNativePrefetchBody } from './mailBodyPrefetch.js';
const message={id:'m',uid:42,folder:'INBOX',provider_message_id:'remote',row_version:1};
const account={id:'a',user_id:'owner',provider_connection_id:'c'};
beforeEach(()=>{vi.clearAllMocks();});
describe('native prefetch transport and policy',()=>{
  it('reads Gmail content with the authorized connection without ordinary attachment downloads',async()=>{
    vi.mocked(fetchGmailMessageContent).mockResolvedValue({complete:true,html:null,text:'Gmail',attachments:[]});
    expect(await readNativePrefetchBody({...account,mail_transport:'gmail_api'},message)).toMatchObject({text:'Gmail',gmailComplete:true});
    expect(fetchGmailMessageContent).toHaveBeenCalledWith({userId:'owner',connectionId:'c',config:{}},'remote');
    expect(collectGmailInlineImages).not.toHaveBeenCalled();expect(fetchGraphMessageBody).not.toHaveBeenCalled();
  });
  it('reads Graph body using immutable identity and leaves attachment metadata for demand reads',async()=>{
    vi.mocked(fetchGraphMessageBody).mockResolvedValue({contentType:'html',content:'<p>Graph</p>'});
    expect(await readNativePrefetchBody({...account,mail_transport:'microsoft_graph'},message)).toEqual({html:'<p>Graph</p>',text:null,graphComplete:true});
    expect(fetchGraphMessageBody).toHaveBeenCalledWith({userId:'owner',connectionId:'c',config:{},immutableIds:true},'remote');
    expect(fetchGmailMessageContent).not.toHaveBeenCalled();
  });
  it('does not guess missing identities or read unsupported transports',async()=>{
    expect(await readNativePrefetchBody({...account,mail_transport:'gmail_api'},{...message,provider_message_id:null})).toBeNull();
    expect(await readNativePrefetchBody({...account,mail_transport:'imap_smtp'},message)).toBeNull();
    expect(fetchGmailMessageContent).not.toHaveBeenCalled();expect(fetchGraphMessageBody).not.toHaveBeenCalled();
  });
  it('respects longer provider backoff and supports disabling speculation',()=>{
    expect(prefetchRetrySeconds({retryAfterSeconds:7200})).toBe(7200);
    expect(prefetchRetrySeconds({retryAfterSeconds:NaN})).toBe(300);
    expect(bodyPrefetchEnabled({MAIL_BODY_PREFETCH:'off'})).toBe(false);
    expect(bodyPrefetchEnabled({})).toBe(true);
  });
});
