// Real PostgreSQL regression tests. CI/test runner must supply a migrated TEST database.
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query,withTransaction } from '../../db.js';
import { MICROSOFT_ISSUER,upsertProviderConnection } from '../../providerAuthService.js';
import { applyGraphMailMessagesPage } from './graphMailSync.js';
import { projectGraphMove } from './graphMailContinuity.js';
import { providerUidForGraphMessage } from './graphMail.js';
if (process.env.DB_HOST && process.env.DB_NAME && !process.env.DB_NAME.includes('test')) {
  throw new Error('Graph continuity tests require an isolated test database');
}
const suite=process.env.DB_HOST && process.env.DB_NAME ? describe:describe.skip;
const userId='00000000-0000-0000-0000-00000000fca1';
const accountId='00000000-0000-0000-0000-00000000fca2';
let connectionId:string;
let nextUid=30000;

/** Isolate all fixtures under a dedicated owner; never touch a real mailbox. */
async function resetFixture():Promise<void>{
  await query('DELETE FROM users WHERE id=$1',[userId]);
  await query("INSERT INTO users(id,username) VALUES ($1,'graph-continuity-regression')",[userId]);
  connectionId=await withTransaction(client=>upsertProviderConnection(client,{userId,provider:'microsoft',issuer:MICROSOFT_ISSUER,subject:'graph-continuity-regression'}));
  await query(`INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host,mail_transport,provider_connection_id)
    VALUES ($1,$2,'Graph regression','regression@example.test','imap','outlook.office365.com','microsoft_graph',$3)`,[accountId,userId,connectionId]);
}

/** Insert a real physical row, including a visible envelope and all flag values. */
async function message(providerId:string|null,folder:string,options:{uid?:string;body?:string;rfc?:string}={}):Promise<string>{
  const id=randomUUID();
  await query(`INSERT INTO messages(id,account_id,uid,folder,provider_message_id,message_id,subject,snippet,from_email,date,is_read,is_starred,has_attachments,body_text)
    VALUES($1,$2,$3,$4,$5,$6,'Keep this subject','Keep this preview','sender@example.test','2026-09-25T12:00:00Z',false,true,true,$7)`,
    [id,accountId,options.uid??String(nextUid++),folder,providerId,options.rfc??'<same-rfc@example.test>',options.body??null]);
  return id;
}

/** Read actual database state; assertions below are not SQL-text-only mocks. */
async function rows(){return (await query<{id:string;folder:string;provider_message_id:string|null;message_id:string|null;subject:string|null;snippet:string|null;is_read:boolean;is_starred:boolean;has_attachments:boolean;is_deleted:boolean;body_text:string|null;uid:string}>(
  'SELECT id,folder,provider_message_id,message_id,subject,snippet,is_read,is_starred,has_attachments,is_deleted,body_text,uid::text AS uid FROM messages WHERE account_id=$1',[accountId])).rows;}

suite('Graph message continuity on PostgreSQL',()=>{
  beforeAll(async()=>{if(!process.env.DB_NAME?.includes('test'))throw new Error('This suite requires a test database');});
  beforeEach(resetFixture);
  afterAll(async()=>{await query('DELETE FROM users WHERE id=$1',[userId]);});

  it('keeps envelope, star and attachment state after an isRead-only delta',async()=>{
    const id=await message('old','INBOX');
    const result=await withTransaction(client=>applyGraphMailMessagesPage(client,{userId,accountId,connectionId,folderPath:'INBOX',remoteFolderId:'graph-inbox'},[{id:'old',isRead:true}]));
    expect(result.ingestRowIds).toEqual([]);
    expect((await rows()).find(row=>row.id===id)).toMatchObject({subject:'Keep this subject',message_id:'<same-rfc@example.test>',snippet:'Keep this preview',is_read:true,is_starred:true,has_attachments:true});
    const visible=await query(`SELECT id FROM messages WHERE id=$1 AND NOT (message_id IS NULL AND (subject IS NULL OR subject='(no subject)') AND COALESCE(snippet,'')='')`,[id]);
    expect(visible.rowCount).toBe(1);
  });
  it('applies explicit false without clearing fields absent from that update',async()=>{
    const id=await message('old','INBOX');
    await withTransaction(client=>applyGraphMailMessagesPage(client,{userId,accountId,connectionId,folderPath:'INBOX'},[{id:'old',flag:{flagStatus:'notFlagged'},subject:''}]));
    expect((await rows()).find(row=>row.id===id)).toMatchObject({is_starred:false,subject:'',snippet:'Keep this preview',has_attachments:true});
  });
  it('moves one canonical UUID and refuses to resurrect a replayed source id',async()=>{
    const id=await message('old','Spam');
    await withTransaction(client=>projectGraphMove(client,{accountId,connectionId,rowId:id,sourceId:'old',targetId:'new',targetPath:'INBOX'}));
    const replay=await withTransaction(client=>applyGraphMailMessagesPage(client,{userId,accountId,connectionId,folderPath:'Spam'},[{id:'old',subject:'stale source page'}]));
    expect(replay.created).toBe(0);expect(replay.skipped).toBe(1);
    expect((await rows()).filter(row=>!row.is_deleted)).toEqual([expect.objectContaining({id,folder:'INBOX',provider_message_id:'new'})]);
  });
  it('does not remove another mail that collides with the derived compatibility UID',async()=>{
    const id=await message('old','Spam');
    const unrelated=await message('unrelated','INBOX',{uid:providerUidForGraphMessage('new')});
    const moved=await withTransaction(client=>projectGraphMove(client,{accountId,connectionId,rowId:id,sourceId:'old',targetId:'new',targetPath:'INBOX'}));
    expect(moved.moved).toBe(true);expect(moved.uid).not.toBe(providerUidForGraphMessage('new'));
    expect((await rows()).find(row=>row.id===unrelated)).toMatchObject({provider_message_id:'unrelated',is_deleted:false});
  });
  it('retains dependent duplicate data as an alias instead of physically deleting it',async()=>{
    const id=await message('old','Spam');
    const duplicate=await message('new','INBOX',{uid:providerUidForGraphMessage('new'),body:'Cached provider body'});
    await withTransaction(client=>projectGraphMove(client,{accountId,connectionId,rowId:id,sourceId:'old',targetId:'new',targetPath:'INBOX'}));
    const actual=await rows();
    expect(actual.find(row=>row.id===id)).toMatchObject({folder:'INBOX',body_text:'Cached provider body',provider_message_id:'new'});
    expect(actual.find(row=>row.id===duplicate)).toMatchObject({is_deleted:true,provider_message_id:null,body_text:'Cached provider body'});
    expect(actual.filter(row=>!row.is_deleted)).toHaveLength(1);
  });
  it('does not merge a Sent copy that merely shares the RFC Message-ID',async()=>{
    const id=await message('received','Spam');const sent=await message('sent','Sent');
    await withTransaction(client=>projectGraphMove(client,{accountId,connectionId,rowId:id,sourceId:'received',targetId:'received-new',targetPath:'INBOX'}));
    expect((await rows()).find(row=>row.id===sent)).toMatchObject({folder:'Sent',provider_message_id:'sent',is_deleted:false});
    expect((await rows()).filter(row=>!row.is_deleted)).toHaveLength(2);
  });
  it('removes a bound legacy source alias from the Spam view after moving its canonical item',async()=>{
    const id=await message('received','Spam');const alias=await message(null,'Spam');
    await query(`INSERT INTO graph_legacy_message_bindings(legacy_message_id,canonical_message_id,account_id,connection_id,status,evidence)
      VALUES($1,$2,$3,$4,'bound','{}'::jsonb)`,[alias,id,accountId,connectionId]);
    await withTransaction(client=>projectGraphMove(client,{accountId,connectionId,rowId:id,sourceId:'received',targetId:'received-new',targetPath:'INBOX'}));
    expect((await rows()).find(row=>row.id===alias)?.is_deleted).toBe(true);
    expect((await rows()).filter(row=>!row.is_deleted)).toEqual([expect.objectContaining({id,folder:'INBOX'})]);
  });
});
