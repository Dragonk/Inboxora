import 'dotenv/config';
import { pool } from '../services/db.js';
import { readStorageMaintenanceStatus } from '../services/storageMaintenance.js';
try {
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--summary' && arg!=='--help')) throw new Error('Usage: storageMaintenanceStatus.js [--summary | --help]');
  if(args.includes('--help')) {
    console.log('Read-only storage maintenance report. --summary shows before/current database sizes, reclaimed journal bytes and header-repair progress.');
  } else {
    const status=await readStorageMaintenanceStatus();
    const baseline=status.tasks.find(t=>t.task==='baseline');
    const before=baseline?.progress.database_before_bytes;
    const after=status.current.database_bytes;
    const headers=status.tasks.filter(t=>t.task.startsWith('headers:'));
    const summary={
      initial_sweep: baseline?.completed_at ? 'complete' : 'pending_or_running',
      database_before_bytes: before ?? null,
      database_current_bytes: after,
      database_before_mib: before === undefined ? null : (Number(before)/1048576).toFixed(2),
      database_current_mib: (Number(after)/1048576).toFixed(2),
      database_change_bytes: before === undefined ? null : (BigInt(String(before))-BigInt(after)).toString(),
      retired_journal_bytes_released: status.tasks.filter(t=>t.task.startsWith('retired:')).reduce((n,t)=>n+Number(t.progress.released_bytes ?? 0),0),
      header_scan_rows: headers.reduce((n,t)=>n+Number(t.progress.scan_rows ?? 0),0),
      header_tasks_pending: headers.filter(t=>t.completed_at === null).length,
      header_tasks_with_errors: headers.filter(t=>t.completed_at === null && t.progress.last_error_code).length,
      headers_repaired: headers.reduce((n,t)=>n+Number(t.progress.repaired ?? 0),0),
      header_logical_bytes_saved: headers.reduce((n,t)=>n+Number(t.progress.logical_bytes_saved ?? 0),0),
      header_candidates_skipped_last_sweep: headers.reduce((n,t)=>n+Number(t.progress.skipped_in_sweep ?? 0),0),
      body_caches_evicted: Number(status.tasks.find(t=>t.task==='body-cache')?.progress.evicted ?? 0),
      body_cache_logical_bytes_saved: Number(status.tasks.find(t=>t.task==='body-cache')?.progress.logical_bytes_saved ?? 0),
      note: 'Logical cache/header savings are not additional measured filesystem savings. Current database size also includes concurrent normal activity.',
    };
    console.log(JSON.stringify(args.includes('--summary')?summary:{summary,...status},null,2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally { await pool.end(); }
