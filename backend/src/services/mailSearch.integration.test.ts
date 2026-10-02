import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const remote = vi.hoisted(() => vi.fn());
vi.mock('./mailSearchRemote.js', async importOriginal => ({
  ...await importOriginal<typeof import('./mailSearchRemote.js')>(), searchRemoteAccount: remote,
}));
import { pool, query } from './db.js';
import { searchMail } from './mailSearch.js';
import { requireMessage, grantSchema, type Grant } from '../mcp/policy.js';

describe.skipIf(process.env.REQUIRE_MCP_POSTGRES !== '1')('mail search SQL and scoped provider hits', () => {
  const user = randomUUID(); const foreignUser = randomUUID();
  const account = randomUUID(); const gmail = randomUUID(); const foreignAccount = randomUUID();
  const phrase = randomUUID(); const separated = randomUUID(); const uncached = randomUUID(); const otherDay = randomUUID();
  const foreign = randomUUID(); const archived = randomUUID(); const labelInbox = randomUUID();
  const input = (q:string, extra:Record<string,unknown> = {}) => ({q,accountId:account,limit:'100',...extra});
  const ids = (result:Awaited<ReturnType<typeof searchMail>>) => result.messages.map(message => message.id);
  beforeAll(async () => {
    await query('INSERT INTO users(id,username) VALUES($1,$2),($3,$4)', [user,`search-${user}`,foreignUser,`search-${foreignUser}`]);
    await query(`INSERT INTO email_accounts(id,user_id,name,email_address,mail_transport) VALUES
      ($1,$4,'IMAP','imap@example.test','imap_smtp'),($2,$4,'Gmail','gmail@example.test','gmail_api'),($3,$5,'Foreign','foreign@example.test','imap_smtp')`,
    [account,gmail,foreignAccount,user,foreignUser]);
    for (const id of [account,gmail,foreignAccount]) await query(`INSERT INTO folders(account_id,path,name,special_use) VALUES
      ($1,'INBOX','Inbox',NULL),($1,'Archive','Archive','\\Archive'),($1,'Trash','Trash','\\Trash')`, [id]);
    await query(`INSERT INTO messages(id,account_id,uid,folder,subject,body_text,date,from_email,to_addresses) VALUES
      ($1,$6,1,'INBOX','Faktura','Numer faktury żółw invoice 100%','2026-09-30T12:00:00Z','alice@example.test','[{"address":"jane@example.test"}]'),
      ($2,$6,2,'INBOX','Other','invoice unrelated words 100%','2026-09-30T11:00:00Z','alice@example.test','[]'),
      ($3,$6,3,'INBOX','Uncached attachment',NULL,'2026-09-30T10:00:00Z','alice@example.test','[]'),
      ($4,$6,4,'Archive','Faktura','Numer faktury żółw invoice 100%','2026-10-01T00:00:00Z','alice@example.test','[]'),
      ($5,$7,5,'INBOX','Foreign invoice','Numer faktury żółw invoice 100%','2026-09-30T13:00:00Z','private@example.test','[]')`,
    [phrase,separated,uncached,otherDay,foreign,account,foreignAccount]);
    await query(`INSERT INTO messages(id,account_id,uid,folder,subject,body_text,date,provider_message_id) VALUES
      ($1,$3,0,'INBOX','Archived native message','label needle','2026-09-30T12:00:00Z','native-archive'),
      ($2,$3,0,'INBOX','Inbox native message','label needle','2026-09-30T11:00:00Z','native-inbox')`,[archived,labelInbox,gmail]);
    await query(`INSERT INTO message_labels(message_id,account_id,label_id,folder_path) VALUES
      ($1,$3,'archive-label','Archive'),($2,$3,'INBOX','INBOX')`,[archived,labelInbox,gmail]);
  });
  beforeEach(() => { remote.mockReset(); remote.mockResolvedValue({rowIds:[],truncated:false}); });
  afterAll(async () => { await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[user,foreignUser]]); await pool.end(); });
  it('uses correctly bound inclusive/exclusive date placeholders', async () => {
    const result = await searchMail(user,input('invoice after:2026-09-30 before:2026-10-01'));
    expect(ids(result)).toContain(phrase); expect(ids(result)).not.toContain(otherDay); expect(ids(result)).not.toContain(foreign);
  });
  it('matches a quoted phrase and Polish text, not separated words', async () => {
    const result = await searchMail(user,input('"invoice 100%" żółw'));
    expect(ids(result).sort()).toEqual([phrase,otherDay].sort());
    expect(ids(await searchMail(user,input('"invoice 100%"')))).not.toContain(separated);
  });
  it('finds matches in recipients and outside the current folder when no folder is selected', async () => {
    expect(ids(await searchMail(user,input('jane@example.test')))).toContain(phrase);
    expect(ids(await searchMail(user,input('żółw')))).toContain(otherDay);
    expect(ids(await searchMail(user,input('żółw',{folder:'INBOX'})))).not.toContain(otherDay);
  });
  it('accepts a provider-confirmed body-only hit without a local cached body', async () => {
    remote.mockResolvedValue({rowIds:[uncached,foreign],truncated:false});
    const result = await searchMail(user,input('server-only-secret-needle'));
    expect(ids(result)).toEqual([uncached]);
  });
  it('does not accept an uncached body as proof that an excluded phrase is absent', async () => {
    expect(ids(await searchMail(user,input('from:alice -"excluded words"')))).not.toContain(uncached);
    remote.mockResolvedValue({rowIds:[uncached],truncated:false});
    expect(ids(await searchMail(user,input('from:alice -"excluded words"')))).toContain(uncached);
  });
  it('enforces integration folder and account permissions before pagination and provider proof', async () => {
    remote.mockResolvedValue({rowIds:[phrase,otherDay,foreign],truncated:false});
    const result = await searchMail(user,input('invoice',{limit:'1'}),{accounts:[account],folders:[{accountId:account,path:'INBOX'}],allAccounts:true});
    expect(ids(result)).toEqual([phrase]);
    expect(await searchMail(user,input('invoice'),{accounts:[],folders:null})).toMatchObject({messages:[]});
  });
  it('uses native Gmail labels, never the archived row’s legacy INBOX coordinate', async () => {
    const result = await searchMail(user,input('needle',{accountId:gmail,folder:'INBOX'}));
    expect(ids(result)).toEqual([labelInbox]);
    const granted = grantSchema.parse({name:'Inbox only',scopes:['mail.read'],restrictions:{accounts:[gmail],folders:[{accountId:gmail,path:'INBOX'}]}});
    const grant:Grant = {id:randomUUID(),user_id:user,client_id:null,name:granted.name,scopes:granted.scopes,restrictions:granted.restrictions,require_confirmation:true,expires_at:new Date(Date.now()+60000),revoked_at:null};
    await expect(requireMessage(grant,archived)).rejects.toThrow(/not found/);
    await expect(requireMessage(grant,labelInbox)).resolves.toMatchObject({id:labelInbox});
  });
  it('returns partial coverage explicitly instead of a misleading complete empty result', async () => {
    remote.mockResolvedValue({rowIds:[],truncated:true,errors:['Server search limit reached.']});
    expect(await searchMail(user,input('not-present'))).toMatchObject({messages:[],partial:true,coverage:'partial'});
  });
  it('rejects impossible calendar dates without issuing a provider search', async () => {
    await expect(searchMail(user,input('after:2026-02-30'))).rejects.toThrow('Invalid search date');
    expect(remote).not.toHaveBeenCalled();
  });
});
