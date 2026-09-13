// Isolated synthetic benchmark. Never uses or modifies an existing user's mail.
// NODE_ENV=test DB_* node src/scripts/benchmarkMessageList.js
import { randomUUID } from 'node:crypto';
import { pool } from '../services/db.js';
import { listMessages } from '../services/messageService.js';

if (process.env.NODE_ENV !== 'test') throw new Error('This benchmark requires NODE_ENV=test and an isolated test database.');
const userId = randomUUID();
const samples = Number(process.env.PERF_SAMPLES || 5);
const perAccount = Number(process.env.PERF_MESSAGES_PER_ACCOUNT || 30000);
const accounts = [];
try {
  await pool.query('INSERT INTO users (id, username) VALUES ($1, $2)', [userId, `performance-${userId}@example.test`]);
  for (let index = 0; index < 3; index += 1) {
    const accountId = randomUUID();
    accounts.push(accountId);
    await pool.query('INSERT INTO email_accounts (id, user_id, name, email_address) VALUES ($1, $2, $3, $4)', [accountId, userId, `Benchmark ${index}`, `bench-${index}@example.test`]);
    await pool.query(`INSERT INTO messages (account_id, uid, folder, message_id, subject, from_email, date, snippet, thread_id, is_read)
      SELECT $1, n, CASE WHEN n % 3 = 0 THEN 'Sent' ELSE 'INBOX' END,
        '<bench-' || n || '@example.test>', 'Benchmark thread ' || (n / 5), 'sender@example.test',
        TIMESTAMPTZ '2026-09-10 12:00:00+00' - n * INTERVAL '1 second', 'Synthetic message', 'shared-key-' || (n / 5), n % 2 = 0
      FROM generate_series(1, $2::int) n`, [accountId, perAccount]);
    await pool.query("INSERT INTO folders (account_id, path, name, total_count) VALUES ($1, 'INBOX', 'Inbox', $2)", [accountId, perAccount - Math.floor(perAccount / 3)]);
  }
  await pool.query('ANALYZE messages');
  const report = { messages: perAccount * accounts.length, samples, cases: {} };
  for (const [name, accountId, threaded] of [['unified-threaded', undefined, true], ['account-threaded', accounts[0], true], ['unified-flat', undefined, false]]) {
    const timings = [];
    let result;
    for (let run = 0; run <= samples; run += 1) {
      const start = performance.now();
      result = await listMessages({ userId, accountId, threaded, limit: 50 });
      if (run) timings.push(Math.round((performance.now() - start) * 10) / 10);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    report.cases[name] = { timingsMs: timings, medianMs: sorted[Math.floor(sorted.length / 2)], rows: result.messages.length, total: result.total };
    if (name === 'unified-threaded') {
      if (new Set(result.messages.map(message => message.thread_id)).size !== 50) throw new Error('Unified thread identities collided across accounts');
      if (new Set(result.messages.map(message => message.account_id)).size !== 3) throw new Error('Missing account in unified listing');
    }
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.end();
}
