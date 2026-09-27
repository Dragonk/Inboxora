import { randomUUID } from 'node:crypto';
import { afterAll,afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { pool,query } from './db.js';
import { applyInboxRules } from './inboxRules.js';
import { hydrateRequiredImapRuleBody } from './imapRuleBody.js';
import { mockImapManager } from '../test/imapClient.js';
const enabled=Boolean(process.env.DB_HOST && process.env.DB_NAME);
if(process.env.REQUIRE_STORAGE_POSTGRES==='1'&&!enabled)throw new Error('Rule read regressions require PostgreSQL');
describe.skipIf(!enabled)('IMAP rule-required bodies with metadata-first sync',()=>{
  let user:string,accountId:string,id:string;
  const account=()=>({id:accountId,user_id:user,mail_transport:'imap_smtp'});
  const message=()=>({id,uid:42,folder:'INBOX',is_read:false,fromEmail:'sender@example.test'});
  const reader=vi.fn();
  const flag=vi.fn(async()=>{});
  const port=mockImapManager({fetchMessageBody:reader,setFlag:flag,_enqueueFlagPush:vi.fn()});
  async function rule(operator='contains') {
    await query(`INSERT INTO inbox_rules(user_id,account_id,name,conditions,actions)
      VALUES($1,$2,'Required body',$3::jsonb,'[{"type":"star"}]')`,[user,accountId,JSON.stringify([{field:'body',operator,value:'invoice'}])]);
  }
  beforeEach(async()=>{
    user=randomUUID();accountId=randomUUID();id=randomUUID();reader.mockReset();flag.mockClear();
    await query("INSERT INTO users(id,username,password_hash) VALUES($1,$2,'unused')",[user,`body-rule-${user}`]);
    await query("INSERT INTO email_accounts(id,user_id,name,email_address,protocol,mail_transport) VALUES($1,$2,'Rules','rules@example.test','imap','imap_smtp')",[accountId,user]);
    await query("INSERT INTO messages(id,account_id,uid,folder,subject) VALUES($1,$2,42,'INBOX','Required body')",[id,accountId]);
  });
  afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await query('DELETE FROM users WHERE id=$1',[user]);});
  afterAll(async()=>{await pool.end();});
  it('reads an uncached body for an enabled rule and matches without opening the UI',async()=>{
    vi.stubEnv('MAIL_BODY_PREFETCH','off');
    await rule();reader.mockResolvedValue({text:'New invoice',html:null,attachments:[{part:'2',filename:'invoice.pdf'}]});
    await applyInboxRules([message()],account(),port);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({id:accountId,user_id:user}), '42','INBOX');
    expect((await query('SELECT body_text,is_starred,attachments FROM messages WHERE id=$1',[id])).rows[0])
      .toEqual({body_text:'New invoice',is_starred:true,attachments:[{part:'2',filename:'invoice.pdf'}]});
    expect(flag).toHaveBeenCalledTimes(1);
  });
  it('uses existing cached text without another provider read',async()=>{
    await rule();await query("UPDATE messages SET body_text='Cached invoice' WHERE id=$1",[id]);
    await applyInboxRules([message()],account(),port);
    expect(reader).not.toHaveBeenCalled();expect(flag).toHaveBeenCalledTimes(1);
  });
  it('extracts cached HTML for a body rule without overwriting attachment metadata',async()=>{
    await rule();await query(`UPDATE messages SET body_html='<p>Cached invoice</p>',attachments='[{"part":"2","filename":"kept.pdf"}]' WHERE id=$1`,[id]);
    await applyInboxRules([message()],account(),port);
    expect(reader).not.toHaveBeenCalled();expect(flag).toHaveBeenCalledTimes(1);
    expect((await query('SELECT attachments FROM messages WHERE id=$1',[id])).rows[0].attachments).toEqual([{part:'2',filename:'kept.pdf'}]);
  });
  it.each(['empty','failed','oversized'])('does not match a negative condition after a %s read',async kind=>{
    await rule('not_contains');vi.spyOn(console,'warn').mockImplementation(()=>{});
    if(kind==='failed')reader.mockRejectedValue(new Error('provider unavailable'));
    else if(kind==='oversized')reader.mockResolvedValue({text:null,html:'<p>'+ 'x'.repeat(1_048_577) +' invoice</p>',attachments:[]});
    else reader.mockResolvedValue({text:'',html:null,attachments:[]});
    await applyInboxRules([message()],account(),port);
    expect(flag).not.toHaveBeenCalled();
    expect((await query('SELECT body_text,is_starred FROM messages WHERE id=$1',[id])).rows[0]).toEqual({body_text:null,is_starred:false});
  });
  it('fences a moved or changed message after the network read',async()=>{
    await rule();reader.mockImplementation(async()=>{
      await query("UPDATE messages SET folder='Archive',row_version=row_version+1 WHERE id=$1",[id]);
      return{text:'invoice',html:null,attachments:[]};
    });
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    await applyInboxRules([message()],account(),port);
    expect(flag).not.toHaveBeenCalled();
    expect((await query('SELECT body_text FROM messages WHERE id=$1',[id])).rows[0].body_text).toBeNull();
  });
  it('refuses another owner and never falls back to IMAP for a native account',async()=>{
    reader.mockResolvedValue({text:'invoice',html:null,attachments:[]});
    expect(await hydrateRequiredImapRuleBody({messageId:id,accountId,userId:randomUUID(),uid:42,folder:'INBOX',read:reader})).toBeUndefined();
    await query("UPDATE email_accounts SET mail_transport='gmail_api' WHERE id=$1",[accountId]);
    expect(await hydrateRequiredImapRuleBody({messageId:id,accountId,userId:user,uid:42,folder:'INBOX',read:reader})).toBeUndefined();
    expect(reader).not.toHaveBeenCalled();
  });
});
