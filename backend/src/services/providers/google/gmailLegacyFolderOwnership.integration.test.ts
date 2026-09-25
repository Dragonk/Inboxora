import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { query, pool } from '../../db.js';
import { gmailFolderPathByLabelId, gmailLabelIdForPath, listGmailFolderTargets, listGmailMailAccounts } from './gmailMailSync.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;
const userId = randomUUID(); const accountId = randomUUID(); const directConnection = randomUUID(); const collectionConnection = randomUUID(); const folderId = randomUUID();

beforeAll(async () => {
  if (!hasPg) return;
  await query('INSERT INTO users (id, username) VALUES ($1,$2)', [userId, `gmail-legacy-${userId}`]);
  await query(`INSERT INTO provider_connections (id,user_id,provider,issuer,subject,provider_user_id,status) VALUES ($1,$3,'google','https://accounts.google.com','direct','legacy@gmail.test','active'),($2,$3,'google','https://accounts.google.com','collections',NULL,'active')`, [directConnection, collectionConnection, userId]);
  await query(`INSERT INTO email_accounts (id,user_id,name,email_address,protocol,imap_host,mail_transport,provider_connection_id) VALUES ($1,$2,'Gmail','legacy@gmail.test','gmail_api','imap.gmail.com','gmail_api',$3)`, [accountId,userId,directConnection]);
  await query(`INSERT INTO folders (id,account_id,path,name,delimiter,special_use,total_count,unread_count) VALUES ($1,$2,'Sent','Sent','/','\\\\Sent',0,0)`, [folderId,accountId]);
  await query(`INSERT INTO integration_collections (user_id,connection_id,account_id,kind,remote_id,local_folder_id,enabled,source_access,user_access,dav_mode) VALUES ($1,$2,NULL,'mail_label','SENT',$3,true,'read_only','source','off')`, [userId,collectionConnection,folderId]);
});
afterAll(async () => { if (hasPg) { await query('DELETE FROM users WHERE id=$1',[userId]); await pool.end(); } });

describeOrSkip('legacy Gmail label ownership (PostgreSQL)', () => {
  it('resolves the mailbox from the connection that owns its legacy labels', async () => { const client = await pool.connect(); try { expect(await listGmailMailAccounts(client, { userId, connectionId: collectionConnection })).toContain(accountId); } finally { client.release(); } });
  it('keeps legacy account_id=NULL label collections in folder targets/path lookup', async () => {
    const client = await pool.connect(); try { expect(await listGmailFolderTargets(client, { connectionId: collectionConnection, accountId })).toEqual(expect.arrayContaining([expect.objectContaining({ remoteId: 'SENT', folderPath: 'Sent' })])); } finally { client.release(); }
    await expect(gmailLabelIdForPath({ connectionId: collectionConnection, accountId, path: 'Sent' })).resolves.toBe('SENT');
    const paths = await gmailFolderPathByLabelId({ connectionId: collectionConnection, accountId }); expect(paths.get('SENT')).toBe('Sent');
  });
});
