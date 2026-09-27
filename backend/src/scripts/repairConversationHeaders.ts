import 'dotenv/config';
import { pool } from '../services/db.js';
import { conversationHeaderRepairAccounts, repairConversationHeadersBatch } from '../services/conversationHeaderRepair.js';
import { toAppError } from '../utils/errors.js';

// An explicit maintenance command, NOT a startup migration: a nearly full
// installation must choose when it has enough WAL/working space for repairs.
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--help'].includes(arg))) {
    throw new Error('Usage: node dist/scripts/repairConversationHeaders.js [--apply | --help]');
  }
  if (args.includes('--help')) {
    console.log('Repair byte-expanded IMAP headers for all local accounts. Default: read-only dry run. --apply commits bounded batches. No vacuum or mail deletion is performed.');
  } else {
    const apply = args.includes('--apply');
    const totals = { scanned: 0, repairable: 0, repaired: 0, skipped: 0, beforeBytes: 0, afterBytes: 0 };
    for (const account of await conversationHeaderRepairAccounts()) {
      let cursor: string | null = null;
      do {
        const batch = await repairConversationHeadersBatch({ userId: account.user_id, accountId: account.id, afterId: cursor, apply });
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += batch[key];
        cursor = batch.next;
      } while (cursor !== null);
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...totals,
      logicalBytesSaved: totals.beforeBytes - totals.afterBytes,
      note: 'Byte counts cover repairable payloads before TOAST compression, not immediate filesystem savings. Skipped values were left intact.' }, null, 2));
  }
} catch (error) {
  console.error('Conversation header repair failed:', toAppError(error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
