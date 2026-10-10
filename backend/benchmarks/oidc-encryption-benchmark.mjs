import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

// Mock encrypt and isEncrypted
const encrypt = (val) => 'enc:v1:' + Buffer.from(val).toString('base64');
const isEncrypted = (val) => val.startsWith('enc:v1:');

// Create test data
const ROWS_COUNT = 1000;
const testRows = Array.from({ length: ROWS_COUNT }).map((_, i) => ({
  id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  client_secret: `secret_${i}`
}));

class MockPool {
  async query(text, params) {
    // Simulate DB latency
    await new Promise(resolve => setTimeout(resolve, 1));
    return { rowCount: 1 };
  }
}

const pool = new MockPool();

async function runBaseline() {
  const oidcResult = { rows: [...testRows] };
  let oidcCount = 0;

  const start = performance.now();
  for (const row of oidcResult.rows) {
    if (row.client_secret && !isEncrypted(row.client_secret)) {
      await pool.query(
        'UPDATE oidc_providers SET client_secret = $1 WHERE id = $2',
        [encrypt(row.client_secret), row.id]
      );
      oidcCount++;
    }
  }
  const end = performance.now();

  return end - start;
}

async function runOptimized() {
  const oidcResult = { rows: [...testRows] };

  const start = performance.now();

  const ids = [];
  const secrets = [];

  for (const row of oidcResult.rows) {
    if (row.client_secret && !isEncrypted(row.client_secret)) {
      ids.push(row.id);
      secrets.push(encrypt(row.client_secret));
    }
  }

  if (ids.length > 0) {
    await pool.query(
      `UPDATE oidc_providers
       SET client_secret = unnest.secret
       FROM UNNEST($1::uuid[], $2::text[]) AS unnest(id, secret)
       WHERE oidc_providers.id = unnest.id`,
      [ids, secrets]
    );
  }

  const end = performance.now();
  return end - start;
}

async function main() {
  console.log('Running baseline...');
  const baselineTime = await runBaseline();
  console.log(`Baseline: ${baselineTime.toFixed(2)} ms`);

  console.log('Running optimized...');
  const optimizedTime = await runOptimized();
  console.log(`Optimized: ${optimizedTime.toFixed(2)} ms`);

  console.log(`Improvement: ${(baselineTime / optimizedTime).toFixed(2)}x faster`);
}

main().catch(console.error);
