import nodemailer from 'nodemailer';
import { refreshMicrosoftToken } from '../routes/oauth.js';
import { decrypt } from './encryption.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { resolveForConnection, type ResolvedConnectionInfo } from './hostValidation.js';
import { toAppError } from '../utils/errors.js';

const SMTP_ATTEMPT_TIMEOUT_MS = 10_000;
const SMTP_FAILOVER_BUDGET_MS = 45_000;

/** The fields of an SMTP failure this module inspects: nodemailer sets `command` to the
 *  protocol stage that failed (e.g. 'CONN' for connection establishment). */
interface SmtpFailureLike {
  message?: unknown;
  command?: string;
}

export function isPreDeliveryConnectionError(err: SmtpFailureLike) {
  return err?.command === 'CONN';
}

/** The transporter nodemailer hands back, and the option/message shapes it uses. */
type NodemailerTransporter = ReturnType<typeof nodemailer.createTransport>;
type NodemailerSentMessageInfo = Awaited<ReturnType<NodemailerTransporter['sendMail']>>;
type NodemailerTransportOptions = NodemailerTransporter['_defaults'];

export interface SmtpTransportLike {
  sendMail?(mailOptions: unknown): Promise<NodemailerSentMessageInfo>;
  verify?(): Promise<unknown>;
  close?(): void;
}

/** The connection options the factory receives, mirroring nodemailer's own option type. */
type SmtpTransportOptions = {
  host?: NodemailerTransportOptions['host'];
  port?: NodemailerTransportOptions['port'];
  secure?: NodemailerTransportOptions['secure'];
  ignoreTLS?: NodemailerTransportOptions['ignoreTLS'];
  requireTLS?: NodemailerTransportOptions['requireTLS'];
  auth?: NodemailerTransportOptions['auth'];
  tls?: NodemailerTransportOptions['tls'];
  connectionTimeout?: NodemailerTransportOptions['connectionTimeout'];
  greetingTimeout?: NodemailerTransportOptions['greetingTimeout'];
};

type CreateTransportFactory = (options: SmtpTransportOptions) => SmtpTransportLike;

/** A transport guaranteed to implement the method an operation calls. */
type SmtpSenderLike = SmtpTransportLike & { sendMail: NonNullable<SmtpTransportLike['sendMail']> };
type SmtpVerifierLike = SmtpTransportLike & { verify: NonNullable<SmtpTransportLike['verify']> };

/** The callbacks this module returns; both are always implemented. */
interface SmtpTransportHandle {
  sendMail(mailOptions: unknown): Promise<NodemailerSentMessageInfo>;
  verify(): Promise<unknown>;
}

async function runWithAddressFallback<T>({
  resolved,
  transportOptions,
  operation,
  createTransport = nodemailer.createTransport,
  now = Date.now,
}: {
  resolved: ResolvedConnectionInfo;
  transportOptions: Record<string, unknown>;
  operation(transport: SmtpTransportLike): Promise<T>;
  createTransport?: CreateTransportFactory;
  now?: () => number;
}) {
  const candidates = [...new Set(
    resolved.addresses?.length ? resolved.addresses : [resolved.host]
  )];
  const startedAt = now();
  let lastError;

  for (let i = 0; i < candidates.length; i++) {
    const remaining = SMTP_FAILOVER_BUDGET_MS - (now() - startedAt);
    if (remaining < 2000 && lastError) throw lastError;
    const attemptTimeout = Math.max(1000, Math.min(SMTP_ATTEMPT_TIMEOUT_MS, Math.floor(remaining / 2)));
    const transport = createTransport({
      ...transportOptions,
      host: candidates[i],
      connectionTimeout: attemptTimeout,
      greetingTimeout: attemptTimeout,
    });

    try {
      return await operation(transport);
    } catch (caught) {
      const err = toAppError(caught);
      lastError = err;
      if (!isPreDeliveryConnectionError(err) || i === candidates.length - 1) throw err;
      console.warn('SMTP connection failed; retrying another validated address:', err.message);
    } finally {
      transport.close?.();
    }
  }

  throw lastError;
}

export function createSmtpTransport(
  resolved: ResolvedConnectionInfo,
  transportOptions: Record<string, unknown>,
  createTransport: CreateTransportFactory = nodemailer.createTransport,
): SmtpTransportHandle {
  return {
    sendMail: mailOptions => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: (transport: SmtpSenderLike) => transport.sendMail(mailOptions),
      createTransport,
    }),
    verify: () => runWithAddressFallback({
      resolved,
      transportOptions,
      operation: (transport: SmtpVerifierLike) => transport.verify(),
      createTransport,
    }),
  };
}

/** The account columns the SMTP setup reads. Partial because callers/tests may pass a subset. */
type SmtpAccountFields = {
  user_id?: string;
  id?: string;
  email_address?: string | null;
  name?: string | null;
  sender_name?: string | null;
  auth_user?: string | null;
  auth_pass?: string | null;
  smtp_auth_user?: string | null;
  smtp_auth_pass?: string | null;
  smtp_host?: string | null;
  smtp_port?: number;
  smtp_tls?: string | null;
  imap_skip_tls_verify?: boolean;
  oauth_provider?: string | null;
  oauth_access_token?: string | null;
  oauth_token_expiry?: string | Date | null;
};

export async function createAccountSmtpTransport<Account extends SmtpAccountFields>(inputAccount: Account) {
  let account: SmtpAccountFields = inputAccount;
  if (account.oauth_provider === 'microsoft') {
    const expiryMs = account.oauth_token_expiry
      ? new Date(account.oauth_token_expiry).getTime()
      : 0;
    if (typeof account.id === 'string' && expiryMs - Date.now() < 5 * 60 * 1000) {
      account = await refreshMicrosoftToken({ ...account, id: account.id });
    }
  }

  let auth;
  if (
    (account.oauth_provider === 'microsoft' || account.oauth_provider === 'google')
    && account.oauth_access_token
  ) {
    const accessToken = decrypt(account.oauth_access_token);
    if (!accessToken) {
      return {
        status: 502,
        error: 'OAuth access token is corrupted — please reconnect your account.',
      };
    }
    auth = {
      type: 'OAuth2',
      user: account.auth_user || account.email_address,
      accessToken,
    };
  } else {
    // Separate SMTP credentials (issue #353): if the account has its own SMTP
    // username/password, use them; otherwise fall back to the IMAP login. Each
    // side falls back independently, so a different-username/same-password (or the
    // reverse) config also works. Empty/NULL columns are falsy and fall through.
    const encryptedPass = account.smtp_auth_pass || account.auth_pass;
    if (typeof encryptedPass !== 'string' || !encryptedPass) {
      return {
        status: 502,
        error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.',
      };
    }
    const pass = decrypt(encryptedPass);
    if (!pass) {
      return {
        status: 502,
        error: 'SMTP password is corrupted or missing — please re-enter your account password in Settings.',
      };
    }
    auth = { user: account.smtp_auth_user || account.auth_user, pass };
  }

  const policy = await getConnectionPolicy();
  const resolved = await resolveForConnection(account.smtp_host, {
    allowPrivate: policy.allowPrivateHosts,
  });
  const plain = account.smtp_tls !== 'STARTTLS' && account.smtp_tls !== 'SSL';
  if (!policy.allowInsecureTls && plain) {
    return {
      status: 403,
      error: 'Plain-text SMTP is not allowed: admin must enable "Allow insecure TLS"',
    };
  }

  const tls: NonNullable<NodemailerTransportOptions['tls']> = {
    rejectUnauthorized: !(policy.allowInsecureTls && account.imap_skip_tls_verify),
  };
  if (resolved.servername) tls.servername = resolved.servername;
  const secure = account.smtp_tls === 'SSL'
    || (account.smtp_tls !== 'none' && account.smtp_port === 465);
  const transport = createSmtpTransport(resolved, {
    port: account.smtp_port,
    secure,
    ...(account.smtp_tls === 'STARTTLS' ? { requireTLS: true } : {}),
    ...(account.smtp_tls === 'none' ? { ignoreTLS: true } : {}),
    auth,
    tls,
  });
  return {
    account: account === inputAccount ? inputAccount : { ...inputAccount, ...account },
    transport,
  };
}