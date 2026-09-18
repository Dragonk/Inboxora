/**
 * Apply pending database migrations, then exit.
 *
 * Used by the Conversation Engine real-app E2E workflow, which needs a migrated
 * database before the backend starts. It lives in a file rather than an inline
 * `tsx -e` snippet because the inline form is compiled as CommonJS, where esbuild
 * rejects top-level await ("Top-level await is currently not supported with the
 * \"cjs\" output format") — which is how that workflow's prepare step kept failing.
 *
 * The exit code matters: the workflow must stop before seeding if a migration fails.
 */
import { pool } from '../services/db.js';
import { runMigrations } from '../services/migrations.js';

try {
  await runMigrations();
  console.log('Database migrations are up to date.');
} catch (error) {
  console.error('Database migrations failed:', error);
  process.exitCode = 1;
} finally {
  // Closing the pool releases the event loop. A failure here is still a failure —
  // report it and keep a non-zero exit code without masking a migration error.
  await pool.end().catch((error: unknown) => {
    console.error('Database pool shutdown failed:', error);
    process.exitCode ||= 1;
  });
}
