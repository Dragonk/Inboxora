import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { signatureTrustEnvironment, startSignatureTrustRefresh } from './signatureTrust.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); spawnMock.mockReset(); });
describe('signature trust-list refresh', () => {
  it('forwards only trust configuration, never mail credentials or proxy settings', () => {
    expect(signatureTrustEnvironment({ PATH: '/bin', PDF_SIGNATURE_EUTL: 'true', PDF_SIGNATURE_EUTL_CACHE: '/cache', DB_PASSWORD: 'secret', HTTPS_PROXY: 'private' })).toEqual({
      PATH: '/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', PDF_SIGNATURE_EUTL: 'true', PDF_SIGNATURE_EUTL_CACHE: '/cache',
    });
  });
  it('does not start network refresh in offline mode', () => {
    vi.stubEnv('PDF_SIGNATURE_ONLINE', 'false');
    startSignatureTrustRefresh()(); expect(spawnMock).not.toHaveBeenCalled();
  });
  it('has no document input, avoids overlap and kills its own process on shutdown', () => {
    vi.useFakeTimers();
    vi.stubEnv('PDF_SIGNATURE_ONLINE', 'true'); vi.stubEnv('PDF_SIGNATURE_EUTL', 'true');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    spawnMock.mockReturnValue(child);
    const stop = startSignatureTrustRefresh();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    vi.advanceTimersByTime(120000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    stop(); vi.advanceTimersByTime(12 * 60 * 60 * 1000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
  it('retries incomplete country lists after thirty minutes and emits only a fixed status', () => {
    vi.useFakeTimers();
    vi.stubEnv('PDF_SIGNATURE_ONLINE', 'true'); vi.stubEnv('PDF_SIGNATURE_EUTL', 'true');
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    spawnMock.mockReturnValue(child);
    const stop = startSignatureTrustRefresh();
    child.stdout.emit('data', Buffer.from('{"status":"partial","unexpected":"private diagnostic"}'));
    child.emit('close', 0);
    expect(log).toHaveBeenCalledWith('PDF signature trust-list refresh: partial');
    vi.advanceTimersByTime(30 * 60 * 1000 - 1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    stop();
  });
  it('backs off failed starts up to one hour, then restores the six-hour success cadence', () => {
    vi.useFakeTimers(); vi.stubEnv('PDF_SIGNATURE_ONLINE', 'true'); vi.stubEnv('PDF_SIGNATURE_EUTL', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }> = [];
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      children.push(child); return child;
    });
    const stop = startSignatureTrustRefresh();
    for (const minutes of [5, 10, 20, 40, 60, 60]) {
      const count = children.length;
      children.at(-1)!.emit('error', new Error('not logged'));
      children.at(-1)!.emit('close', -2);
      vi.advanceTimersByTime(minutes * 60 * 1000 - 1);
      expect(children).toHaveLength(count);
      vi.advanceTimersByTime(1); expect(children).toHaveLength(count + 1);
    }
    children.at(-1)!.stdout.emit('data', Buffer.from('{"status":"ready"}'));
    children.at(-1)!.emit('close', 0);
    const count = children.length;
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1); expect(children).toHaveLength(count);
    vi.advanceTimersByTime(1); expect(children).toHaveLength(count + 1);
    stop(); vi.advanceTimersByTime(24 * 60 * 60 * 1000); expect(children).toHaveLength(count + 1);
  });

});
