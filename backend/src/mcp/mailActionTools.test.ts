import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from './policy.js';
const f=vi.hoisted(()=>({query:vi.fn(),request:vi.fn(),folder:vi.fn(),message:vi.fn()}));
vi.mock('../services/db.js',()=>({query:f.query,withTransaction:vi.fn()}));
vi.mock('./bridge.js',()=>({domainRequest:f.request}));
vi.mock('../utils/mailUtils.js',()=>({resolveAllDraftsPaths:async()=>new Set(['Drafts']),resolveAllTrashPaths:async()=>new Set(['Trash']),
  resolveAllSpamPaths:async()=>new Set(['Junk']),resolveArchiveFolder:async()=> 'Archive',resolveSpamFolder:async()=> 'Junk',resolveTrashFolder:async()=> 'Trash'}));
vi.mock('./policy.js',async original=>({...await original<typeof import('./policy.js')>(),requireFolder:f.folder,requireMessage:f.message}));
vi.mock('./operations.js',()=>({runOperation:async(...args:Parameters<typeof import('./operations.js')['runOperation']>)=>{
  const [grant,,,authorize,execute]=args;await authorize(grant);return {result:await execute('synthetic-operation',{})};
}}));
import { mailActionTools } from './mailActionTools.js';
const account='11111111-1111-4111-8111-111111111111';
const message='22222222-2222-4222-8222-222222222222';
const grant:Grant={id:message,user_id:message,client_id:null,name:'Synthetic action test',scopes:['mail.modify','mail.spam','mail.unsubscribe'],
  restrictions:{accounts:null,folders:null,calendars:null,addressBooks:null},require_confirmation:true,expires_at:new Date(Date.now()+60000),revoked_at:null};
async function invoke(name:string,args:Record<string,unknown>={}){
  const tool=mailActionTools.find(tool=>tool.definition.name===name);
  if(!tool)throw new Error('Missing tool');return tool.invoke(grant,{messageId:message,requestId:'stable-operation',...args});
}
beforeEach(()=>{
  vi.clearAllMocks();
  f.message.mockResolvedValue({id:message,account_id:account,folder:'Junk'});
  f.folder.mockResolvedValue(undefined);
  f.query.mockResolvedValue({rows:[{folder_mappings:{inbox:'Posteingang'},mail_transport:'imap_smtp'}]});
  f.request.mockResolvedValue({status:200,body:{ok:true}});
});
describe('MCP action receipts and authorization',()=>{
  it.each([{}, {ok:true,moved:[]}])('does not report an unconfirmed move as successful %#',async body=>{
    f.request.mockResolvedValue({status:200,body});
    expect(await invoke('move_email',{destinationFolder:'Archive'})).toMatchObject({result:{status:502,body:{code:'MOVE_UNCONFIRMED'}}});
  });
  it('accepts the confirmed replacement ID returned by Graph',async()=>{
    f.request.mockResolvedValue({status:200,body:{ok:true,moved:['replacement-row']}});
    expect(await invoke('move_email',{destinationFolder:'Archive'})).toMatchObject({result:{status:200,body:{moved:['replacement-row']}}});
  });
  it('requires access to the mapped inbox before removing spam status',async()=>{
    await invoke('mark_email_not_spam');
    expect(f.folder).toHaveBeenCalledWith(grant,account,'Posteingang');
  });
  it('rejects non-spam messages before recording an approval',async()=>{
    f.message.mockResolvedValue({id:message,account_id:account,folder:'INBOX'});
    await expect(invoke('mark_email_not_spam')).rejects.toThrow('not in the spam folder');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses manual unsubscribe links without claiming any email was sent',async()=>{
    f.request.mockResolvedValue({status:200,body:{ok:true,state:'offered',url:'https://example.test/unsubscribe',mailto:null}});
    expect(await invoke('unsubscribe_email')).toMatchObject({result:{status:422,body:{ok:false,code:'UNSUBSCRIBE_MANUAL_ACTION_REQUIRED',url:'https://example.test/unsubscribe'}}});
  });
  it('preserves a confirmed one-click unsubscribe receipt',async()=>{
    f.request.mockResolvedValue({status:200,body:{ok:true,state:'confirmed'}});
    expect(await invoke('unsubscribe_email')).toMatchObject({result:{status:200,body:{state:'confirmed'}}});
  });
});
