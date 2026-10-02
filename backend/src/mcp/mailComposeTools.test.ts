import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Grant } from './policy.js';
const f = vi.hoisted(() => ({ query: vi.fn(), read: vi.fn(), request: vi.fn(), source: vi.fn(), scan: vi.fn(), send: vi.fn() }));
vi.mock('../index.js', () => ({imapManager:{fetchAttachment:vi.fn()}}));
vi.mock('../services/db.js', () => ({query:f.query,withTransaction:vi.fn()}));
vi.mock('./bridge.js', () => ({domainRead:f.read,domainRequest:f.request}));
vi.mock('../services/sourceAttachments.js', () => ({fetchSourceAttachment:f.source}));
vi.mock('../services/attachments/scan.js', () => ({scanAttachment:f.scan}));
vi.mock('../services/sendMail.js', () => ({executeSend:f.send}));
vi.mock('../utils/mailUtils.js', () => ({resolveAllDraftsPaths:async()=>new Set(['Drafts'])}));
vi.mock('./policy.js', async original => ({...await original<typeof import('./policy.js')>(),
  requireAccount:vi.fn(), requireFolder:vi.fn(), requireMessage:async()=>({id:'22222222-2222-4222-8222-222222222222',account_id:'11111111-1111-4111-8111-111111111111',folder:'Drafts'}),
}));
vi.mock('./operations.js', () => ({runOperation:async (...args:Parameters<typeof import('./operations.js')['runOperation']>) => {
  const [grant,,,authorize,execute,prepare] = args;
  await authorize(grant);
  return {result:await execute('operation-test',prepare ? await prepare() : {})};
}}));
import { mailComposeTools } from './mailComposeTools.js';
import { reprepareEditedMail } from './mailApprovalEdit.js';
const accountId='11111111-1111-4111-8111-111111111111';
const messageId='22222222-2222-4222-8222-222222222222';
const grant:Grant={id:messageId,user_id:messageId,client_id:null,name:'Unit test',scopes:['mail.read','mail.draft','mail.send'],
  restrictions:{accounts:null,folders:null,calendars:null,addressBooks:null},require_confirmation:true,expires_at:new Date(Date.now()+60000),revoked_at:null};
const args={accountId,to:['to@example.test'],body:'Authored body',requestId:'stable-test-id'};
async function invoke(name:string, values:Record<string,unknown>) {
  const tool=mailComposeTools.find(item=>item.definition.name===name);
  if(!tool) throw new Error('Missing test tool');
  return tool.invoke(grant,values);
}
beforeEach(()=>{
  vi.clearAllMocks();
  f.query.mockImplementation(async(sql:string)=>{
    if(sql.includes('FROM email_accounts')) return {rows:[{id:accountId,user_id:messageId,email_address:'me@example.test',signature:'Signature',folder_mappings:{drafts:'Drafts'},default_cc:['default@example.test'],default_bcc:['private@example.test']}]};
    if(sql.includes('SELECT uid,draft_uid_validity')) return {rows:[{uid:'42',draft_uid_validity:'7'}]};
    if(sql.includes('SELECT draft_composition')) return {rows:[{draft_composition:{quotedBody:'Original quote',replyKind:'reply',replyParentMessageId:'<parent@example.test>',replyParentAccountId:accountId},draft_in_reply_to:'<parent@example.test>',draft_references:'<parent@example.test>'}]};
    if(sql.includes('SELECT uid,folder,provider_message_id')) return {rows:[{uid:42,folder:'Drafts',provider_message_id:null}]};
    throw new Error('Unexpected SQL: '+sql);
  });
  f.read.mockImplementation(async(_user:string,path:string)=>path.endsWith('/body')?{text:'Original quote',attachments:[{part:'2',filename:'original.txt',type:'text/plain',size:10}]}:{message_id:'<parent@example.test>',thread_references:'<ancestor@example.test>'});
  f.request.mockResolvedValue({status:200,body:{ok:true}});
  f.source.mockResolvedValue(Buffer.from('attachment'));
  f.scan.mockResolvedValue('clean');
  f.send.mockImplementation(async(_user:string,payload:unknown,_key:unknown,options:{prepareOnly?:boolean})=>options.prepareOnly
    ? {status:200,body:{ok:true},prepared:{senderEmail:'me@example.test',payload}}
    : {status:200,body:{ok:true}});
});
describe('MCP composition passes the real domain contract',()=>{
  it('replaces a draft by complete identity and preserves its reply context',async()=>{
    await invoke('update_draft',{...args,messageId});
    expect(f.request).toHaveBeenCalledWith(messageId,'POST','/mail/draft',expect.objectContaining({
      existingDraft:{accountId,uid:'42',folder:'Drafts',uidValidity:'7'},
      quotedBody:'Original quote',inReplyTo:'<parent@example.test>',replyKind:'reply',
      cc:['default@example.test'],bcc:['private@example.test'],editedSignature:'Signature',
    }),'operation-test');
  });
  it('uses an RFC parent reference rather than a row UUID in replies',async()=>{
    await invoke('reply_email',{...args,messageId,cc:[],bcc:[]});
    expect(f.send).toHaveBeenCalledWith(messageId,expect.objectContaining({replyParentMessageId:'<parent@example.test>',cc:[],bcc:[]}),null,{prepareOnly:true});
  });
  it('freezes and scans forwarded bytes before preparing a send',async()=>{
    await invoke('forward_email',{...args,messageId,forwardedAttachments:[{messageId,part:'2'}]});
    expect(f.source).toHaveBeenCalledWith(expect.objectContaining({maxBytes:1024*1024}));
    expect(f.scan).toHaveBeenCalledWith(Buffer.from('attachment'),expect.any(AbortSignal));
    expect(f.send).toHaveBeenCalledWith(messageId,expect.objectContaining({forwardedAttachments:[],attachments:[expect.objectContaining({content:Buffer.from('attachment').toString('base64')})]}),null,{prepareOnly:true});
  });
  it.each([[' Text/Plain; charset=utf-8 ','text/plain'],['invalid header',undefined]])('normalizes forwarded MIME %s before freezing a draft',async(type,expected)=>{
    f.read.mockResolvedValue({text:'Original',attachments:[{part:'2',filename:'file.txt',type,size:10}]});
    await invoke('create_draft',{...args,forwardedAttachments:[{messageId,part:'2'}]});
    expect(f.request).toHaveBeenCalledWith(messageId,'POST','/mail/draft',expect.objectContaining({
      attachments:[{filename:'file.txt',content:Buffer.from('attachment').toString('base64'),contentType:expected}],
    }),'operation-test');
  });
  it('revalidates human edits and regenerates the exact approval preview',async()=>{
    const prepared={senderEmail:'me@example.test',senderName:'Owner',payload:{accountId,to:['old@example.test'],cc:[],bcc:[],subject:'Old',body:'Old body',bodyIsHtml:false,editedSignature:'Configured',editedSignatureIsHtml:true,attachments:[],forwardedAttachments:[],priority:'normal'},review:{kind:'mail',signatureMode:'configured'}};
    const edited=await reprepareEditedMail(messageId,prepared,{to:['edited@example.test'],cc:[],bcc:['private@example.test'],subject:'Edited',body:'Edited body',bodyIsHtml:true,bodyChanged:true,signature:'Edited signature',signatureIsHtml:true,signatureChanged:true});
    expect(f.send).toHaveBeenCalledWith(messageId,expect.objectContaining({to:['edited@example.test'],bcc:['private@example.test'],subject:'Edited',body:'Edited body',editedSignature:'Edited signature'}),null,
      {prepareOnly:true,expectedSenderEmail:'me@example.test',expectedSenderName:'Owner'});
    expect(edited.review).toMatchObject({kind:'mail',to:['edited@example.test'],bcc:['private@example.test'],subject:'Edited',signatureMode:'override'});
  });
  it('keeps the frozen HTML body and configured signature when only recipients change',async()=>{
    const prepared={senderEmail:'me@example.test',senderName:'Owner',payload:{accountId,to:['old@example.test'],cc:[],bcc:[],subject:'Old',body:'<p>Rich body</p>',bodyIsHtml:true,editedSignature:'<strong>Configured</strong>',editedSignatureIsHtml:true,attachments:[],forwardedAttachments:[],priority:'normal'},review:{kind:'mail',signatureMode:'configured'}};
    const edited=await reprepareEditedMail(messageId,prepared,{to:['edited@example.test'],cc:[],bcc:[],subject:'Old',body:'ignored editor snapshot',bodyIsHtml:true,bodyChanged:false,signature:'ignored editor snapshot',signatureIsHtml:true,signatureChanged:false});
    expect(f.send).toHaveBeenCalledWith(messageId,expect.objectContaining({to:['edited@example.test'],body:'<p>Rich body</p>',bodyIsHtml:true,editedSignature:'<strong>Configured</strong>',editedSignatureIsHtml:true}),null,
      {prepareOnly:true,expectedSenderEmail:'me@example.test',expectedSenderName:'Owner'});
    expect(edited.review).toMatchObject({kind:'mail',to:['edited@example.test'],signatureMode:'configured'});
  });
  it('refuses oversized forwarded data before calling the send pipeline',async()=>{
    f.source.mockResolvedValue(Buffer.alloc(1024*1024+1));
    await expect(invoke('send_email',{...args,forwardedAttachments:[{messageId,part:'2'}]})).rejects.toThrow('byte budget');
    expect(f.send).not.toHaveBeenCalled();
  });
});
