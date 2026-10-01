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

/** Refresh on startup, then six-hourly. Retry outages with bounded backoff rather
 * than leaving a cold server without trust for six hours. Never overlap jobs. */
export function startSignatureTrustRefresh(): () => void {
  if (process.env.PDF_SIGNATURE_EUTL?.toLowerCase() === 'false' || process.env.PDF_SIGNATURE_ONLINE?.toLowerCase() === 'false') return () => undefined;
  let stopped = false;
  let child: ChildProcess | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const schedule = (status: string) => {
    if (stopped || status === 'disabled') return;
    const delay = status === 'ready' ? 6 * 60 * 60 * 1000
      : status === 'partial' ? 30 * 60 * 1000
      : Math.min(60, 5 * 2 ** Math.min(failures++, 4)) * 60 * 1000;
    if (status === 'ready' || status === 'partial') failures = 0;
    scheduled = setTimeout(refresh, delay); scheduled.unref();
  };
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
          schedule(result.status);
          return;
        }
      } catch { /* Only fixed diagnostics may reach the application log. */ }
      console.warn('PDF signature trust-list refresh unavailable; no unverified lists will be used.');
      schedule('unavailable');
    });
  };
  refresh();
  return () => { stopped = true; clearTimeout(scheduled); clearTimeout(timeout); child?.kill('SIGKILL'); };
}
