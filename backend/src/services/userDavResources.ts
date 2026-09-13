// Provision the local DAV collections that belong to every Inboxora user.
// The caller supplies a transaction client so a new account and its DAV resources
// either commit together or roll back together.
export async function ensureUserDavResources(client, userId) {
  if (!userId) throw new Error('User id is required');
  if (!client?.query) throw new Error('A database client is required');

  await client.query(
    `INSERT INTO address_books (user_id, name, source)
     VALUES ($1, 'Personal', 'local')
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId],
  );
  await client.query(
    `INSERT INTO calendars (user_id, owner_user_id, name, source, read_only)
     VALUES ($1, $1, 'Personal', 'local', false)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId],
  );
}
