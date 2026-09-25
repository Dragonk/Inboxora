import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { query } from './db.js';
import { accountDeletionPlan, deleteAccountWithProviderArtifacts } from './accountDeletionCleanup.js';

const hasPg = process.env.DB_HOST && process.env.DB_NAME;
const describeOrSkip = hasPg ? describe : describe.skip;

const userId = randomUUID();
const accountId = randomUUID();
const connectionId = randomUUID();
const calendarId = randomUUID();
const bookId = randomUUID();

beforeAll(async () => {
  if (!hasPg) return;
  await query("INSERT INTO users (id, username) VALUES ($1,$2)", [userId, `delete-${userId}`]);
  await query(
    `INSERT INTO provider_connections
       (id,user_id,provider,issuer,subject,provider_user_id,status)
     VALUES ($1,$2,'microsoft','https://login.microsoftonline.com/common/v2.0',
             'delete-subject','deleted@example.test','active')`,
    [connectionId,userId],
  );
  await query(
    `INSERT INTO email_accounts
       (id,user_id,name,email_address,protocol,imap_host,mail_transport,provider_connection_id)
     VALUES ($1,$2,'Microsoft','deleted@example.test','imap','outlook.office365.com',
             'microsoft_graph',$3)`,
    [accountId,userId,connectionId],
  );
  await query(
    `INSERT INTO calendars (id,user_id,owner_user_id,name,source,read_only)
     VALUES ($1,$2,$2,'Remote calendar','microsoft',true)`,
    [calendarId,userId],
  );
  await query(
    `INSERT INTO address_books (id,user_id,name,source,visible)
     VALUES ($1,$2,'Remote contacts','microsoft',true)`,
    [bookId,userId],
  );
  // Deliberately legacy: account_id is NULL, which used to survive account deletion.
  await query(
    `INSERT INTO integration_collections
       (user_id,connection_id,account_id,kind,remote_id,local_calendar_id,
        enabled,source_access,user_access,dav_mode)
     VALUES ($1,$2,NULL,'calendar','cal-1',$3,true,'read_only','source','off')`,
    [userId,connectionId,calendarId],
  );
  await query(
    `INSERT INTO integration_collections
       (user_id,connection_id,account_id,kind,remote_id,local_address_book_id,
        enabled,source_access,user_access,dav_mode)
     VALUES ($1,$2,NULL,'address_book','book-1',$3,true,'read_only','source','off')`,
    [userId,connectionId,bookId],
  );
});

afterAll(async () => {
  if (!hasPg) return;
  await query('DELETE FROM users WHERE id = $1', [userId]);
});

describeOrSkip('native account deletion cleanup', () => {
  it('removes exclusive provider connection and legacy calendar/contact projections', async () => {
    const plan = await accountDeletionPlan(userId, accountId);
    expect(plan).not.toBeNull();
    expect(plan!.connectionsToDelete).toContain(connectionId);
    const result = await deleteAccountWithProviderArtifacts(userId, accountId, plan!);
    expect(result).toEqual({ calendars: 1, addressBooks: 1 });

    expect((await query('SELECT id FROM email_accounts WHERE id=$1',[accountId])).rows).toHaveLength(0);
    expect((await query('SELECT id FROM provider_connections WHERE id=$1',[connectionId])).rows).toHaveLength(0);
    expect((await query('SELECT id FROM calendars WHERE id=$1',[calendarId])).rows).toHaveLength(0);
    expect((await query('SELECT id FROM address_books WHERE id=$1',[bookId])).rows).toHaveLength(0);
  });
});
