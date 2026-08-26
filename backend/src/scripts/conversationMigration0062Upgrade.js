import { createHash } from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../migrations');
const schema = process.env.DB_SCHEMA || process.env.MIGRATION_GATE_SCHEMA || 'conversation_migration_0062_gate';

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('DB_SCHEMA must be a simple PostgreSQL identifier');
const qi = value => `"${value.replaceAll('"', '""')}"`;

const IDS = Object.freeze({
  user: '62000000-0000-0000-0000-000000000001',
  accountA: '62000000-0000-0000-0000-00000000000a',
  accountB: '62000000-0000-0000-0000-00000000000b',
  sharedConversation: '62000000-0000-0000-0001-000000000001',
  targetConversation: '62000000-0000-0000-0001-000000000002',
  aliasConversation: '62000000-0000-0000-0001-000000000003',
  localAConversation: '62000000-0000-0000-0001-00000000000a',
  localBConversation: '62000000-0000-0000-0001-00000000000b',
  rootLogical: '62000000-0000-0000-0002-000000000001',
  childLogical: '62000000-0000-0000-0002-000000000002',
  targetLogical: '62000000-0000-0000-0002-000000000003',
  aliasLogical: '62000000-0000-0000-0002-000000000004',
  localALogical: '62000000-0000-0000-0002-00000000000a',
  localBLogical: '62000000-0000-0000-0002-00000000000b',
});

function invariant(condition, message, details = undefined) {
  if (!condition) {
    const error = new Error(message);
    if (details !== undefined) error.details = details;
    throw error;
  }
}

function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let single = false;
  let double = false;
  let lineComment = false;
  let blockDepth = 0;
  let dollarTag = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockDepth) {
      if (ch === '/' && next === '*') { blockDepth++; i++; }
      else if (ch === '*' && next === '/') { blockDepth--; i++; }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (single) {
      if (ch === "'" && next === "'") i++;
      else if (ch === "'") single = false;
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') i++;
      else if (ch === '"') double = false;
      continue;
    }
    if (ch === '-' && next === '-') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockDepth = 1; i++; continue; }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += dollarTag.length - 1; continue; }
    }
    if (ch === ';') {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  invariant(!single && !double && !dollarTag && !blockDepth, 'Unterminated SQL quote/comment while splitting no-transaction migration');
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

async function loadMigrations() {
  const names = (await readdir(migrationsDir)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const selected = names.filter(name => Number(name.slice(0, 4)) <= 62);
  invariant(selected.length === 62, 'Expected exactly 62 migrations through 0062', { selected });
  selected.forEach((name, index) => invariant(Number(name.slice(0, 4)) === index + 1, `Migration sequence gap at ${String(index + 1).padStart(4, '0')}`, { name }));
  invariant(selected.at(-1) === '0062_conversation_account_identity.sql', 'Unexpected migration 0062 filename', { filename: selected.at(-1) });
  return Promise.all(selected.map(async name => {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    return { name, version: name.replace(/\.sql$/, ''), sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
}

async function applyMigration(client, migration) {
  try {
    const noTransaction = /^--\s*no-transaction\b/im.test(migration.sql);
    if (noTransaction) {
      for (const statement of splitStatements(migration.sql)) await client.query(statement);
      await client.query('INSERT INTO schema_migrations(version, sha256) VALUES ($1,$2)', [migration.version, migration.sha256]);
      return;
    }
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations(version, sha256) VALUES ($1,$2)', [migration.version, migration.sha256]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } catch (error) {
    error.message = `migration ${migration.name}: ${error.message}`;
    throw error;
  }
}

async function resetSchema(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
  await client.query(`CREATE SCHEMA ${qi(schema)}`);
  await client.query(`SET search_path TO ${qi(schema)}`);
  await client.query("SET TIME ZONE 'UTC'");
  await client.query('CREATE TABLE schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW(), sha256 TEXT)');
}

async function seedFixture(client) {
  let stage = 'user';
  try {
  stage = 'user';
  await client.query("INSERT INTO users(id, username, display_name) VALUES ($1, 'migration-0062-release-gate', 'Migration 0062 Gate')", [IDS.user]);
  stage = 'accounts';
  await client.query(`
    INSERT INTO email_accounts(id,user_id,name,email_address,protocol,imap_host,auth_user,sender_name)
    VALUES
      ($2,$1,'Account A','account-a@example.test','imap','127.0.0.1','account-a@example.test','Account A'),
      ($3,$1,'Account B','account-b@example.test','imap','127.0.0.1','account-b@example.test','Account B')
  `, [IDS.user, IDS.accountA, IDS.accountB]);

  stage = 'conversations';
  await client.query(`
    INSERT INTO conversations
      (id,user_id,kind,subject_snapshot,canonical_subject,first_message_at,last_message_at,logical_message_count,copy_count,unread_count,algorithm_version,threading_confidence,manually_locked,segment_number)
    VALUES
      ($2,$1,'human_reply_chain','Shared release gate','shared release gate','2026-01-01T10:00:00Z','2026-01-01T10:05:00Z',2,4,2,'conversation-v2',0.9900,true,1),
      ($3,$1,'manual_conversation','Shared target','shared target','2026-01-02T10:00:00Z','2026-01-02T10:00:00Z',1,2,0,'conversation-v2',0.9500,false,1),
      ($4,$1,'manual_conversation','Shared alias','shared alias','2026-01-03T10:00:00Z','2026-01-03T10:00:00Z',1,2,0,'conversation-v2',0.9500,false,1),
      ($5,$1,'human_reply_chain','Local A','local a','2026-01-04T10:00:00Z','2026-01-04T10:00:00Z',1,1,1,'conversation-v2',0.9000,false,1),
      ($6,$1,'human_reply_chain','Local B','local b','2026-01-05T10:00:00Z','2026-01-05T10:00:00Z',1,1,0,'conversation-v2',0.9000,false,1)
  `, [IDS.user, IDS.sharedConversation, IDS.targetConversation, IDS.aliasConversation, IDS.localAConversation, IDS.localBConversation]);

  stage = 'logical_messages';
  await client.query(`
    INSERT INTO logical_messages
      (id,user_id,conversation_id,canonical_message_id,raw_message_id,message_id_collision_key,parent_logical_message_id,raw_in_reply_to,raw_references,parsed_in_reply_to,parsed_references,subject,canonical_subject,from_address,sender_address,recipient_signature,sender_signature,direction,message_date,received_at,body_fingerprint,header_fingerprint,threading_reason,threading_confidence,algorithm_version,diagnostics,raw_headers)
    VALUES
      ($2,$1,$8,'<shared-root@fixture.test>','<shared-root@fixture.test>','collision-shared-root',NULL,NULL,NULL,'[]','[]','Shared release gate','shared release gate','sender@example.test',NULL,'account-a@example.test|account-b@example.test','sender@example.test','incoming','2026-01-01T10:00:00Z','2026-01-01T10:00:01Z','body-root','header-root','new-conversation',0.9900,'conversation-v2','{"fixture":"root"}','Message-ID: <shared-root@fixture.test>'),
      ($3,$1,$8,'<shared-child@fixture.test>','<shared-child@fixture.test>','collision-shared-child',$2,'<shared-root@fixture.test>','<shared-root@fixture.test>','["<shared-root@fixture.test>"]','["<shared-root@fixture.test>"]','Re: Shared release gate','shared release gate','reply@example.test',NULL,'account-a@example.test|account-b@example.test','reply@example.test','incoming','2026-01-01T10:05:00Z','2026-01-01T10:05:01Z','body-child','header-child','rfc-parent',0.9900,'conversation-v2','{"fixture":"child"}','Message-ID: <shared-child@fixture.test>'),
      ($4,$1,$9,'<shared-target@fixture.test>','<shared-target@fixture.test>','collision-shared-target',NULL,NULL,NULL,'[]','[]','Shared target','shared target','target@example.test',NULL,'account-a@example.test|account-b@example.test','target@example.test','incoming','2026-01-02T10:00:00Z','2026-01-02T10:00:01Z','body-target','header-target','new-conversation',0.9500,'conversation-v2','{"fixture":"target"}','Message-ID: <shared-target@fixture.test>'),
      ($5,$1,$10,'<shared-alias@fixture.test>','<shared-alias@fixture.test>','collision-shared-alias',NULL,NULL,NULL,'[]','[]','Shared alias','shared alias','alias@example.test',NULL,'account-a@example.test|account-b@example.test','alias@example.test','incoming','2026-01-03T10:00:00Z','2026-01-03T10:00:01Z','body-alias','header-alias','new-conversation',0.9500,'conversation-v2','{"fixture":"alias"}','Message-ID: <shared-alias@fixture.test>'),
      ($6,$1,$11,'<local-a@fixture.test>','<local-a@fixture.test>','collision-local-a',NULL,NULL,NULL,'[]','[]','Local A','local a','local-a@example.test',NULL,'account-a@example.test','local-a@example.test','incoming','2026-01-04T10:00:00Z','2026-01-04T10:00:01Z','body-local-a','header-local-a','new-conversation',0.9000,'conversation-v2','{"fixture":"local-a"}','Message-ID: <local-a@fixture.test>'),
      ($7,$1,$12,'<local-b@fixture.test>','<local-b@fixture.test>','collision-local-b',NULL,NULL,NULL,'[]','[]','Local B','local b','local-b@example.test',NULL,'account-b@example.test','local-b@example.test','incoming','2026-01-05T10:00:00Z','2026-01-05T10:00:01Z','body-local-b','header-local-b','new-conversation',0.9000,'conversation-v2','{"fixture":"local-b"}','Message-ID: <local-b@fixture.test>')
  `, [IDS.user, IDS.rootLogical, IDS.childLogical, IDS.targetLogical, IDS.aliasLogical, IDS.localALogical, IDS.localBLogical, IDS.sharedConversation, IDS.targetConversation, IDS.aliasConversation, IDS.localAConversation, IDS.localBConversation]);

  stage = 'messages';
  const messageRows = [
    [IDS.accountA, 101, 'INBOX', '<shared-root@fixture.test>', 'Shared release gate', 'sender@example.test', IDS.rootLogical, IDS.sharedConversation, '2026-01-01T10:00:00Z', null, null, 'provider-root-a', 'provider-shared-a'],
    [IDS.accountB, 201, 'INBOX', '<shared-root@fixture.test>', 'Shared release gate', 'sender@example.test', IDS.rootLogical, IDS.sharedConversation, '2026-01-01T10:00:00Z', null, null, 'provider-root-b', 'provider-shared-b'],
    [IDS.accountA, 102, 'INBOX', '<shared-child@fixture.test>', 'Re: Shared release gate', 'reply@example.test', IDS.childLogical, IDS.sharedConversation, '2026-01-01T10:05:00Z', '<shared-root@fixture.test>', '<shared-root@fixture.test>', 'provider-child-a', 'provider-shared-a'],
    [IDS.accountB, 202, 'INBOX', '<shared-child@fixture.test>', 'Re: Shared release gate', 'reply@example.test', IDS.childLogical, IDS.sharedConversation, '2026-01-01T10:05:00Z', '<shared-root@fixture.test>', '<shared-root@fixture.test>', 'provider-child-b', 'provider-shared-b'],
    [IDS.accountA, 103, 'INBOX', '<shared-target@fixture.test>', 'Shared target', 'target@example.test', IDS.targetLogical, IDS.targetConversation, '2026-01-02T10:00:00Z', null, null, 'provider-target-a', 'provider-target-a'],
    [IDS.accountB, 203, 'INBOX', '<shared-target@fixture.test>', 'Shared target', 'target@example.test', IDS.targetLogical, IDS.targetConversation, '2026-01-02T10:00:00Z', null, null, 'provider-target-b', 'provider-target-b'],
    [IDS.accountA, 104, 'INBOX', '<shared-alias@fixture.test>', 'Shared alias', 'alias@example.test', IDS.aliasLogical, IDS.aliasConversation, '2026-01-03T10:00:00Z', null, null, 'provider-alias-a', 'provider-alias-a'],
    [IDS.accountB, 204, 'INBOX', '<shared-alias@fixture.test>', 'Shared alias', 'alias@example.test', IDS.aliasLogical, IDS.aliasConversation, '2026-01-03T10:00:00Z', null, null, 'provider-alias-b', 'provider-alias-b'],
    [IDS.accountA, 105, 'INBOX', '<local-a@fixture.test>', 'Local A', 'local-a@example.test', IDS.localALogical, IDS.localAConversation, '2026-01-04T10:00:00Z', null, null, 'provider-local-a', 'provider-local-a'],
    [IDS.accountB, 205, 'INBOX', '<local-b@fixture.test>', 'Local B', 'local-b@example.test', IDS.localBLogical, IDS.localBConversation, '2026-01-05T10:00:00Z', null, null, 'provider-local-b', 'provider-local-b'],
  ];
  for (let index = 0; index < messageRows.length; index++) {
    const [accountId, uid, folder, messageId, subject, fromEmail, logicalId, conversationId, date, inReplyTo, references, providerMessageId, providerThreadId] = messageRows[index];
    const row = {
      id: `62000000-0000-0000-0003-${String(index + 1).padStart(12, '0')}`,
      accountId, uid, folder, messageId, subject, fromEmail, logicalId, conversationId, date,
      inReplyTo, references, providerMessageId, providerThreadId,
      toAddresses: [{ name: accountId === IDS.accountA ? 'Account A' : 'Account B', email: accountId === IDS.accountA ? 'account-a@example.test' : 'account-b@example.test' }],
      deliveryAddresses: [accountId === IDS.accountA ? 'account-a@example.test' : 'account-b@example.test'],
      snippet: `payload-snippet-${index + 1}`,
      bodyText: `payload-text-${index + 1}`,
      bodyHtml: `<p>payload-html-${index + 1}</p>`,
      isRead: index % 2 === 1,
      rawHeaders: `Message-ID: ${messageId}\r\nX-Fixture: ${index + 1}`,
      userId: IDS.user,
    };
    await client.query(`
      INSERT INTO messages
        (id,account_id,uid,folder,message_id,subject,from_name,from_email,to_addresses,cc_addresses,date,snippet,body_text,body_html,is_read,is_starred,is_deleted,has_attachments,attachments,flags,reply_to,in_reply_to,thread_references,thread_id,delivery_addresses,sender_email,sender_name,logical_message_id,conversation_id,canonical_message_id,provider_message_id,provider_thread_id,provider_namespace,threading_reason,threading_confidence,threading_algorithm_version,conversation_raw_headers,conversation_thread_index,conversation_thread_topic,conversation_user_id,automated_series_mode)
      SELECT x.id,x.account_id,x.uid,x.folder,x.message_id,x.subject,'Fixture Sender',x.from_email,x.to_addresses,'[]'::jsonb,x.message_date,x.snippet,x.body_text,x.body_html,x.is_read,false,false,false,'[]'::jsonb,'["Seen"]'::jsonb,'[]'::jsonb,x.in_reply_to,x.thread_references,x.message_id,x.delivery_addresses,NULL,NULL,x.logical_message_id,x.conversation_id,x.message_id,x.provider_message_id,x.provider_thread_id,'fixture-provider','legacy-fixture',0.9900,'conversation-v2',x.raw_headers,x.thread_references,'fixture-topic',x.user_id,'off'
        FROM jsonb_to_record($1::jsonb) AS x(
          id uuid, account_id uuid, uid bigint, folder varchar, message_id varchar, subject text,
          from_email varchar, to_addresses jsonb, message_date timestamptz, snippet text, body_text text,
          body_html text, is_read boolean, in_reply_to text, thread_references text, delivery_addresses jsonb,
          logical_message_id uuid, conversation_id uuid, provider_message_id text, provider_thread_id text,
          raw_headers text, user_id uuid
        )
    `, [JSON.stringify({
      id: row.id, account_id: row.accountId, uid: row.uid, folder: row.folder,
      message_id: row.messageId, subject: row.subject, from_email: row.fromEmail,
      to_addresses: row.toAddresses, message_date: row.date, snippet: row.snippet,
      body_text: row.bodyText, body_html: row.bodyHtml, is_read: row.isRead,
      in_reply_to: row.inReplyTo, thread_references: row.references,
      delivery_addresses: row.deliveryAddresses, logical_message_id: row.logicalId,
      conversation_id: row.conversationId, provider_message_id: row.providerMessageId,
      provider_thread_id: row.providerThreadId, raw_headers: row.rawHeaders, user_id: row.userId,
    })]);
  }

  stage = 'provider_mappings';
  await client.query(`
    INSERT INTO provider_thread_mappings(user_id,account_id,provider,provider_thread_id,conversation_id,diagnostics)
    VALUES
      ($1,$2,'fixture-provider','provider-shared-a',$4,'{"fixture":"mapping-a"}'),
      ($1,$3,'fixture-provider','provider-shared-b',$4,'{"fixture":"mapping-b"}')
  `, [IDS.user, IDS.accountA, IDS.accountB, IDS.sharedConversation]);
  stage = 'unresolved';
  await client.query(`
    INSERT INTO unresolved_message_references(id,user_id,child_logical_message_id,referenced_message_id,relation_type,reference_position,resolved_logical_message_id,resolved_at)
    VALUES
      ('62000000-0000-0000-0004-000000000001',$1,$2,'<shared-root@fixture.test>','references',0,$3,'2026-01-01T10:05:02Z'),
      ('62000000-0000-0000-0004-000000000002',$1,$2,'<missing@fixture.test>','references',1,NULL,NULL)
  `, [IDS.user, IDS.childLogical, IDS.rootLogical]);
  stage = 'alias';
  await client.query("INSERT INTO conversation_aliases(user_id,alias_conversation_id,canonical_conversation_id,reason) VALUES ($1,$2,$3,'fixture-alias')", [IDS.user, IDS.aliasConversation, IDS.sharedConversation]);
  stage = 'evidence';
  await client.query(`INSERT INTO conversation_evidence(id,user_id,conversation_id,logical_message_id,evidence_type,evidence_value_hash,weight,details)
    VALUES ('62000000-0000-0000-0005-000000000001',$1,$2,$3,'rfc-parent','fixture-evidence',0.9900,'{"fixture":"evidence"}')`, [IDS.user, IDS.sharedConversation, IDS.childLogical]);

  stage = 'overrides';
  const overrides = [
    ['62000000-0000-0000-0006-000000000001', IDS.sharedConversation, IDS.childLogical, 'manual-split', null, 'fixture manual split'],
    ['62000000-0000-0000-0006-000000000002', IDS.sharedConversation, IDS.childLogical, 'manual-move', IDS.targetConversation, 'fixture manual move'],
    ['62000000-0000-0000-0006-000000000003', IDS.sharedConversation, IDS.childLogical, 'force-include', IDS.targetConversation, 'fixture force include'],
    ['62000000-0000-0000-0006-000000000004', IDS.sharedConversation, IDS.childLogical, 'force-exclude', null, 'fixture force exclude'],
    ['62000000-0000-0000-0006-000000000005', IDS.aliasConversation, null, 'manual-merge', IDS.targetConversation, 'fixture manual merge'],
    ['62000000-0000-0000-0006-000000000006', IDS.localAConversation, IDS.localALogical, 'manual-move', IDS.localBConversation, 'fixture invalid cross-account target'],
  ];
  for (const [id, conversationId, logicalId, type, targetId, reason] of overrides) {
    await client.query(`INSERT INTO conversation_overrides(id,user_id,conversation_id,logical_message_id,override_type,target_id,target_user_id,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, IDS.user, conversationId, logicalId, type, targetId, targetId ? IDS.user : null, reason]);
  }
  } catch (error) {
    error.message = `fixture stage ${stage}: ${error.message}`;
    throw error;
  }
}

const countTables = [
  'messages', 'conversations', 'logical_messages', 'provider_thread_mappings',
  'unresolved_message_references', 'conversation_aliases', 'conversation_evidence', 'conversation_overrides',
];

async function snapshotCounts(client) {
  const result = {};
  for (const table of countTables) result[table] = Number((await client.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
  return result;
}

async function messagePayloadSnapshot(client) {
  const result = await client.query(`
    SELECT COUNT(*)::int AS count,
           md5(COALESCE(string_agg((to_jsonb(m) - ARRAY[
             'logical_message_id','conversation_id','conversation_user_id'
           ]::text[])::text, E'\n' ORDER BY m.id), '')) AS checksum
      FROM messages m
  `);
  return result.rows[0];
}

async function mismatchCounts(client) {
  const queries = {
    message_logical: `SELECT COUNT(*) FROM messages m JOIN logical_messages lm ON lm.id=m.logical_message_id WHERE m.account_id<>lm.account_id OR m.conversation_user_id<>lm.user_id`,
    message_conversation: `SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.account_id<>c.account_id OR m.conversation_user_id<>c.user_id`,
    logical_conversation: `SELECT COUNT(*) FROM logical_messages lm JOIN conversations c ON c.id=lm.conversation_id WHERE lm.account_id<>c.account_id OR lm.user_id<>c.user_id`,
    logical_parent: `SELECT COUNT(*) FROM logical_messages child JOIN logical_messages parent ON parent.id=child.parent_logical_message_id WHERE child.account_id<>parent.account_id OR child.user_id<>parent.user_id`,
    provider_mapping: `SELECT COUNT(*) FROM provider_thread_mappings p JOIN conversations c ON c.id=p.conversation_id WHERE p.account_id<>c.account_id OR p.user_id<>c.user_id`,
    unresolved_references: `SELECT COUNT(*) FROM unresolved_message_references u JOIN logical_messages child ON child.id=u.child_logical_message_id LEFT JOIN logical_messages resolved ON resolved.id=u.resolved_logical_message_id WHERE u.account_id<>child.account_id OR u.user_id<>child.user_id OR (resolved.id IS NOT NULL AND (u.account_id<>resolved.account_id OR u.user_id<>resolved.user_id))`,
    aliases: `SELECT COUNT(*) FROM conversation_aliases a JOIN conversations source ON source.id=a.alias_conversation_id JOIN conversations canonical ON canonical.id=a.canonical_conversation_id WHERE a.account_id<>source.account_id OR a.account_id<>canonical.account_id OR a.user_id<>source.user_id OR a.user_id<>canonical.user_id`,
    evidence: `SELECT COUNT(*) FROM conversation_evidence e JOIN conversations c ON c.id=e.conversation_id LEFT JOIN logical_messages lm ON lm.id=e.logical_message_id WHERE e.account_id<>c.account_id OR e.user_id<>c.user_id OR (lm.id IS NOT NULL AND (e.account_id<>lm.account_id OR e.user_id<>lm.user_id))`,
    overrides: `SELECT COUNT(*) FROM conversation_overrides o LEFT JOIN conversations c ON c.id=o.conversation_id LEFT JOIN logical_messages lm ON lm.id=o.logical_message_id LEFT JOIN conversations target ON target.id=o.target_id WHERE (c.id IS NOT NULL AND (o.account_id<>c.account_id OR o.user_id<>c.user_id)) OR (lm.id IS NOT NULL AND (o.account_id<>lm.account_id OR o.user_id<>lm.user_id)) OR (target.id IS NOT NULL AND (o.account_id<>target.account_id OR o.user_id<>target.user_id))`,
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) result[name] = Number((await client.query(sql)).rows[0].count);
  return result;
}

async function assertMigrationResult(client, before) {
  const afterCounts = await snapshotCounts(client);
  const afterPayload = await messagePayloadSnapshot(client);
  invariant(afterPayload.count === before.payload.count, 'Physical message loss detected', { before: before.payload, after: afterPayload });
  invariant(afterPayload.checksum === before.payload.checksum, 'Message payload changed during migration', { before: before.payload, after: afterPayload });

  const expectedDeltas = {
    messages: 0,
    conversations: 3,
    logical_messages: 4,
    provider_thread_mappings: 0,
    unresolved_message_references: 2,
    conversation_aliases: 1,
    conversation_evidence: 1,
    conversation_overrides: 5,
  };
  const actualDeltas = Object.fromEntries(countTables.map(table => [table, afterCounts[table] - before.counts[table]]));
  invariant(JSON.stringify(actualDeltas) === JSON.stringify(expectedDeltas), 'Unexpected migration clone deltas', { expectedDeltas, actualDeltas, before: before.counts, after: afterCounts });

  const mismatches = await mismatchCounts(client);
  invariant(Object.keys(mismatches).length === 9, 'Release gate must contain exactly nine account mismatch queries');
  invariant(Object.values(mismatches).every(value => value === 0), 'Account mismatch query failed', mismatches);

  const canonical = await client.query(`SELECT account_id, COUNT(*)::int AS count FROM logical_messages WHERE user_id=$1 AND canonical_message_id='<shared-root@fixture.test>' AND message_id_collision_key='collision-shared-root' GROUP BY account_id ORDER BY account_id`, [IDS.user]);
  invariant(canonical.rows.length === 2 && canonical.rows.every(row => row.count === 1), 'Same canonical Message-ID was not split once per account', canonical.rows);

  let sameAccountUnique = false;
  await client.query('SAVEPOINT uniqueness_probe');
  try {
    await client.query(`INSERT INTO logical_messages(user_id,account_id,canonical_message_id,raw_message_id,message_id_collision_key,direction) VALUES($1,$2,'<shared-root@fixture.test>','<shared-root@fixture.test>','collision-shared-root','unknown')`, [IDS.user, IDS.accountA]);
  } catch (error) {
    sameAccountUnique = error.code === '23505';
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT uniqueness_probe');
    await client.query('RELEASE SAVEPOINT uniqueness_probe');
  }
  invariant(sameAccountUnique, 'Same-account canonical Message-ID uniqueness was not enforced');

  const overrideSummary = await client.query(`SELECT override_type,account_id,COUNT(*)::int AS count FROM conversation_overrides GROUP BY override_type,account_id ORDER BY override_type,account_id`);
  for (const type of ['manual-split', 'manual-move', 'force-include', 'force-exclude', 'manual-merge']) {
    const rows = overrideSummary.rows.filter(row => row.override_type === type);
    invariant(rows.some(row => row.account_id === IDS.accountA) && rows.some(row => row.account_id === IDS.accountB), `Override type ${type} was not retained account-locally`, rows);
  }
  const invalidTarget = await client.query(`SELECT account_id,target_id,target_user_id,reason FROM conversation_overrides WHERE id='62000000-0000-0000-0006-000000000006'`);
  invariant(invalidTarget.rows.length === 1 && invalidTarget.rows[0].account_id === IDS.accountA && invalidTarget.rows[0].target_id === null && invalidTarget.rows[0].target_user_id === null && invalidTarget.rows[0].reason.includes('[0062: cross-account target removed; original target='), 'Invalid cross-account override target was not retained as auditable state', invalidTarget.rows);

  const retained = {
    mappings: Number((await client.query('SELECT COUNT(*) FROM provider_thread_mappings')).rows[0].count),
    unresolvedResolved: Number((await client.query('SELECT COUNT(*) FROM unresolved_message_references WHERE resolved_logical_message_id IS NOT NULL AND resolved_at IS NOT NULL')).rows[0].count),
    unresolvedPending: Number((await client.query('SELECT COUNT(*) FROM unresolved_message_references WHERE resolved_logical_message_id IS NULL AND resolved_at IS NULL')).rows[0].count),
  };
  invariant(retained.mappings === 2 && retained.unresolvedResolved === 2 && retained.unresolvedPending === 2, 'Mappings or unresolved references were not retained', retained);

  const split = await client.query(`SELECT m.account_id,lm.account_id AS logical_account,c.account_id AS conversation_account,lm.id AS logical_id,c.id AS conversation_id FROM messages m JOIN logical_messages lm ON lm.id=m.logical_message_id JOIN conversations c ON c.id=m.conversation_id WHERE m.message_id='<shared-root@fixture.test>' ORDER BY m.account_id`);
  invariant(split.rows.length === 2 && split.rows[0].account_id !== split.rows[1].account_id && split.rows[0].logical_id !== split.rows[1].logical_id && split.rows[0].conversation_id !== split.rows[1].conversation_id && split.rows.every(row => row.account_id === row.logical_account && row.account_id === row.conversation_account), 'A/B identity split failed', split.rows);

  const locked = await client.query(`SELECT account_id,manually_locked FROM conversations WHERE subject_snapshot='Shared release gate' ORDER BY account_id`);
  invariant(locked.rows.length === 2 && locked.rows.every(row => row.manually_locked), 'Locked conversation state was not cloned', locked.rows);

  return { afterCounts, actualDeltas, mismatches, retained, split: split.rows.map(row => ({ accountId: row.account_id, logicalId: row.logical_id, conversationId: row.conversation_id })) };
}

async function accountStateRows(client, accountId) {
  const result = await client.query(`
    WITH rows AS (
      SELECT 'messages' AS kind,id::text AS id,(to_jsonb(m)-ARRAY['synced_at']::text[]) AS data FROM messages m WHERE account_id=$1
      UNION ALL SELECT 'conversations',id::text,to_jsonb(c)-ARRAY['updated_at']::text[] FROM conversations c WHERE account_id=$1
      UNION ALL SELECT 'logical_messages',id::text,to_jsonb(lm)-ARRAY['updated_at']::text[] FROM logical_messages lm WHERE account_id=$1
      UNION ALL SELECT 'provider_thread_mappings',concat_ws(':',provider,provider_thread_id),to_jsonb(p)-ARRAY['last_seen_at']::text[] FROM provider_thread_mappings p WHERE account_id=$1
      UNION ALL SELECT 'unresolved_message_references',id::text,to_jsonb(u) FROM unresolved_message_references u WHERE account_id=$1
      UNION ALL SELECT 'conversation_aliases',alias_conversation_id::text,to_jsonb(a) FROM conversation_aliases a WHERE account_id=$1
      UNION ALL SELECT 'conversation_evidence',id::text,to_jsonb(e) FROM conversation_evidence e WHERE account_id=$1
      UNION ALL SELECT 'conversation_overrides',id::text,to_jsonb(o) FROM conversation_overrides o WHERE account_id=$1
    ) SELECT kind,id,data FROM rows ORDER BY kind,id
  `, [accountId]);
  return result.rows;
}

async function accountChecksum(client, accountId) {
  const rows = await accountStateRows(client, accountId);
  return {
    checksum: createHash('md5').update(rows.map(row => `${row.kind}:${row.id}:${row.data}`).join('\n')).digest('hex'),
    rows: rows.length,
  };
}

async function runRebuildToCompletion(rebuildConversationCopies, { userId, accountId, limit = 3 }) {
  let cursor = null;
  let scanned = 0;
  let updated = 0;
  let batches = 0;
  do {
    const result = await rebuildConversationCopies({ userId, accountId, limit, dryRun: false, cursor });
    scanned += result.scanned || 0;
    updated += result.updated || 0;
    batches++;
    cursor = result.next;
    if (result.complete) return { scanned, updated, batches, complete: true };
    invariant(cursor, 'Incomplete rebuild returned no cursor', result);
  } while (batches < 100);
  throw new Error('Rebuild exceeded 100 batches');
}

async function main() {
  const migrations = await loadMigrations();
  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || process.env.PGDATABASE || process.env.DB_USER || process.env.PGUSER || 'postgres',
    user: process.env.DB_USER || process.env.PGUSER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.PGPASSWORD || undefined,
    ssl: /^(1|true|require)$/i.test(process.env.DB_SSL || '') ? { rejectUnauthorized: false } : undefined,
    options: `-c search_path=${schema} -c statement_timeout=0`,
  });
  await client.connect();
  let pool;
  try {
    await resetSchema(client);
    for (const migration of migrations.slice(0, 61)) await applyMigration(client, migration);
    const appliedBefore = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    invariant(appliedBefore.rows.length === 61 && appliedBefore.rows.at(-1).version.startsWith('0061_'), 'Did not apply exactly migrations 0001..0061', appliedBefore.rows);

    await seedFixture(client);
    const before = { counts: await snapshotCounts(client), payload: await messagePayloadSnapshot(client) };

    await applyMigration(client, migrations[61]);
    const appliedAfter = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    invariant(appliedAfter.rows.length === 62 && appliedAfter.rows.at(-1).version === migrations[61].version, '0062 was not the only post-snapshot migration', appliedAfter.rows);

    await client.query('BEGIN');
    const migrationAssertions = await assertMigrationResult(client, before);
    await client.query('COMMIT');

    const dbModule = await import('../services/db.js');
    pool = dbModule.pool;
    pool.options.host = process.env.DB_HOST || '127.0.0.1';
    pool.options.port = Number(process.env.DB_PORT || 5432);
    pool.options.database = process.env.DB_NAME || process.env.PGDATABASE || process.env.DB_USER || process.env.PGUSER || 'postgres';
    pool.options.user = process.env.DB_USER || process.env.PGUSER || 'postgres';
    pool.options.password = process.env.DB_PASSWORD || process.env.PGPASSWORD || undefined;
    pool.options.options = `-c search_path=${schema} -c statement_timeout=30000`;
    const { rebuildConversationCopies } = await import('../services/conversationRebuild.js');

    const bBeforeA = await accountChecksum(client, IDS.accountB);
    const firstA = await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountA });
    const bAfterA = await accountChecksum(client, IDS.accountB);
    invariant(JSON.stringify(bAfterA) === JSON.stringify(bBeforeA), 'Account A rebuild changed account B checksum', { before: bBeforeA, after: bAfterA });

    const firstB = await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountB });
    // The first rebuild normalizes legacy collision keys and other replay-derived
    // metadata. Treat the next forced pass as convergence, then require the
    // following pass to be a true no-op over the account-local identity graph.
    await client.query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id=$1 AND scope_account_id IN ($2,$3)', [IDS.user, IDS.accountA, IDS.accountB]);
    await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountA });
    await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountB });
    const stableA = await accountChecksum(client, IDS.accountA);
    const stableB = await accountChecksum(client, IDS.accountB);
    const stableRowsA = await accountStateRows(client, IDS.accountA);
    const stableRowsB = await accountStateRows(client, IDS.accountB);

    await client.query('DELETE FROM conversation_rebuild_checkpoints WHERE user_id=$1 AND scope_account_id IN ($2,$3)', [IDS.user, IDS.accountA, IDS.accountB]);
    const secondA = await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountA });
    const secondB = await runRebuildToCompletion(rebuildConversationCopies, { userId: IDS.user, accountId: IDS.accountB });
    invariant(secondA.updated === 0 && secondB.updated === 0, 'Idempotent rebuild rerun updated rows', { secondA, secondB });
    const finalA = await accountChecksum(client, IDS.accountA);
    const finalB = await accountChecksum(client, IDS.accountB);
    const finalRowsA = await accountStateRows(client, IDS.accountA);
    const finalRowsB = await accountStateRows(client, IDS.accountB);
    const changedRows = (before, after) => {
      const prior = new Map(before.map(row => [`${row.kind}:${row.id}`, row.data]));
      const current = new Map(after.map(row => [`${row.kind}:${row.id}`, row.data]));
      return [...new Set([...prior.keys(), ...current.keys()])]
        .filter(key => prior.get(key) !== current.get(key))
        .map(key => ({ key, before: prior.get(key), after: current.get(key) }));
    };
    invariant(JSON.stringify(finalA) === JSON.stringify(stableA) && JSON.stringify(finalB) === JSON.stringify(stableB), 'Account checksums changed on idempotent rebuild rerun', { stableA, stableB, finalA, finalB, changedA: changedRows(stableRowsA, finalRowsA), changedB: changedRows(stableRowsB, finalRowsB) });

    const finalMismatches = await mismatchCounts(client);
    invariant(Object.values(finalMismatches).every(value => value === 0), 'Rebuild introduced account mismatches', finalMismatches);

    console.log(JSON.stringify({
      ok: true,
      gate: 'conversation-migration-0062-upgrade',
      schema,
      migrations: { legacyApplied: 61, upgradeApplied: migrations[61].version },
      fixture: { userId: IDS.user, accountA: IDS.accountA, accountB: IDS.accountB, beforeCounts: before.counts },
      migration: migrationAssertions,
      rebuild: {
        first: { accountA: firstA, accountB: firstB, accountBUnaffectedByA: true },
        idempotent: { accountA: secondA, accountB: secondB, checksumsStable: true },
        checksums: { accountA: finalA, accountB: finalB },
      },
      finalMismatches,
    }));
  } finally {
    if (pool) await pool.end().catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, gate: 'conversation-migration-0062-upgrade', error: error.message, code: error.code || null, details: error.details || error.stack || null }));
  process.exitCode = 1;
});
