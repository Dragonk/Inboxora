import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Trust-list refresh has no document input and never inherits application secrets. */
export function signatureTrustEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: source.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of ['PDF_SIGNATURE_EUTL', 'PDF_SIGNATURE_EUTL_CACHE', 'PDF_SIGNATURE_ONLINE']) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

/** Refresh on startup, then six-hourly. Failed/missing lists remain unavailable;
 * workers reverify signatures and freshness, so the cache cannot confer trust. */
export function startSignatureTrustRefresh(): () => void {
  if (process.env.PDF_SIGNATURE_EUTL?.toLowerCase() === 'false' || process.env.PDF_SIGNATURE_ONLINE?.toLowerCase() === 'false') return () => undefined;
  let stopped = false;
  let child: ChildProcess | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (stopped || child) return;
    const current = spawn(process.env.ATTACHMENT_PREVIEW_PYTHON || 'python3',
      ['-B', fileURLToPath(new URL('../../../preview/trust_lists.py', import.meta.url))],
      { env: signatureTrustEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    child = current;
    let output = ''; let failed = false;
    current.stderr?.resume();
    timeout = setTimeout(() => { failed = true; current.kill('SIGKILL'); }, 120_000);
    timeout.unref();
    current.stdout?.on('data', (value: Buffer) => {
      if (output.length + value.length > 8192) { failed = true; current.kill('SIGKILL'); return; }
      output += value.toString('utf-8');
    });
    current.once('error', () => { failed = true; });
    current.once('close', (code) => {
      clearTimeout(timeout);
      if (child === current) child = undefined;
      if (stopped) return;
      try {
        const result: unknown = JSON.parse(output);
        if (!failed && code === 0 && result && typeof result === 'object' && 'status' in result
          && typeof result.status === 'string' && ['ready', 'partial', 'disabled', 'busy'].includes(result.status)) {
          console.info(`PDF signature trust-list refresh: ${result.status}`);
          return;
        }
      } catch { /* Only fixed diagnostics may reach the application log. */ }
      console.warn('PDF signature trust-list refresh unavailable; no unverified lists will be used.');
    });
  };
  refresh();
  const interval = setInterval(refresh, 6 * 60 * 60 * 1000); interval.unref();
  return () => { stopped = true; clearInterval(interval); clearTimeout(timeout); child?.kill('SIGKILL'); };
}
