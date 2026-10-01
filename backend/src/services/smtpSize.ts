import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection } from './hostValidation.js';
import { effectiveSendLimits, mailMaxAttachmentBytes, type EffectiveSendLimits } from './sendLimits.js';
import { transportKindForAccount } from './providers/mailCapabilities.js';

interface SizeAccount { id?: string; user_id?: string; mail_transport?: string | null; smtp_host?: string | null; smtp_port?: number; smtp_tls?: string | null; imap_skip_tls_verify?: boolean }
interface Discovery { bytes: number | null; source: 'advertised' | 'not_advertised' | 'unavailable' | 'provider' }
const cache = new Map<string, { until: number; value: Promise<Discovery> }>();
let active = 0;
/** EHLO/STARTTLS only: no authentication, recipients or message transmission. */
export async function discoverSmtpSize(account: SizeAccount): Promise<Discovery> {
  if (!account.id || !account.smtp_host) return { bytes: null, source: 'unavailable' };
  let policy: Awaited<ReturnType<typeof getConnectionPolicy>>;
  try { policy = await getConnectionPolicy(); } catch { return { bytes: null, source: 'unavailable' }; }
  const key = JSON.stringify([account.user_id, account.id, account.smtp_host, account.smtp_port, account.smtp_tls, account.imap_skip_tls_verify, policy]);
  const cached = cache.get(key); if (cached && cached.until > Date.now()) return cached.value;
  if (active >= 4) return { bytes: null, source: 'unavailable' };
  active++;
  const value = (async (): Promise<Discovery> => {
    try {
      const plain = account.smtp_tls !== 'SSL' && account.smtp_tls !== 'STARTTLS';
      if (plain && !policy.allowInsecureTls) return { bytes: null, source: 'unavailable' };
      const resolved = await resolveForConnection(account.smtp_host, { allowPrivate: policy.allowPrivateHosts });
      return await new Promise<Discovery>(resolve => {
        const connection = new SMTPConnection({ host: resolved.addresses?.[0] || resolved.host, port: account.smtp_port,
          secure: account.smtp_tls === 'SSL', requireTLS: account.smtp_tls === 'STARTTLS', ignoreTLS: account.smtp_tls === 'none',
          tls: { servername: resolved.servername ?? undefined, rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify) },
          connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 4000, maxResponseSize: 32768, logger: false, debug: false });
        let settled = false;
        const finish = (answer: Discovery) => { if (settled) return; settled = true; clearTimeout(timer); connection.close(); resolve(answer); };
        const timer = setTimeout(() => finish({ bytes: null, source: 'unavailable' }), 5000);
        connection.on('error', () => finish({ bytes: null, source: 'unavailable' }));
        connection.on('end', () => finish({ bytes: null, source: 'unavailable' }));
        connection.connect(() => {
          // Nodemailer has no public unauthenticated capability accessor. Treat this
          // optional runtime property as unknown, and fall back if its contract changes.
          const candidate: unknown = connection;
          const size = candidate && typeof candidate === 'object' && '_maxAllowedSize' in candidate ? candidate._maxAllowedSize : null;
          finish(typeof size === 'number' && Number.isSafeInteger(size) && size > 0
            ? { bytes: size, source: 'advertised' } : { bytes: null, source: 'not_advertised' });
        });
      });
    } catch { return { bytes: null, source: 'unavailable' }; }
    finally { active--; }
  })();
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(key, { until: Date.now() + 60000, value }); return value;
}
export function applyAdvertisedSize(limits: EffectiveSendLimits, bytes: number | null, hard = mailMaxAttachmentBytes()): EffectiveSendLimits {
  if (limits.transport !== 'smtp' || bytes === null || !Number.isSafeInteger(bytes) || bytes < 1) return limits;
  return { ...limits, composedMessageBytes: bytes, providerMessageBytes: bytes, composedMessageFromFallback: false,
    singleAttachmentBytes: Math.min(hard, bytes), totalAttachmentBytes: Math.min(hard, bytes), inlineImageBytes: Math.min(hard, bytes) };
}
export async function accountSendLimits(account: SizeAccount) {
  const transport = transportKindForAccount(account); const limits = effectiveSendLimits(transport);
  const discovery: Discovery = transport === 'smtp' ? await discoverSmtpSize(account) : { bytes: null, source: 'provider' };
  return { limits: applyAdvertisedSize(limits, discovery.bytes), discovery };
}
/** A conservative chooser estimate. The send path still measures exact MIME bytes. */
export function chooserAttachmentCeiling(limits: EffectiveSendLimits): number {
  return limits.transport === 'smtp' ? Math.max(0, Math.floor((limits.composedMessageBytes - 65536) * 57 / 78)) : limits.totalAttachmentBytes;
}
