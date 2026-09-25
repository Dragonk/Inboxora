import { useCallback, useState } from 'react';
import { api } from '../utils/api.ts';
import { toAppError } from '../utils/errors.ts';

/**
 * "Add account", in Settings → Accounts.
 *
 * The rule this screen exists to enforce: **Integrations configure provider applications, Accounts connect
 * individual mailboxes.** So the user picks a mailbox kind here — Microsoft, Google or another provider over
 * IMAP/SMTP — and never sees a client id, a secret, a tenant or a redirect URI; when the administrator has not
 * configured a provider yet, the screen says so and offers to go to Integrations instead of failing later.
 *
 * The provider authorizations are the existing ones: Microsoft browser or device code against the provider
 * connection with the mail scopes, and Google's browser flow with the Gmail scope. Once the connection exists,
 * `POST /api/accounts/native` creates the account with the identity the provider reported — and when that
 * mailbox is already added over IMAP, it answers with the account that exists so the user can migrate it
 * rather than add it twice.
 */

export interface ProviderReadiness {
  configured?: boolean;
  enabled?: boolean;
  browser?: { ready?: boolean; missing?: string[] };
  deviceCode?: { supported?: boolean; ready?: boolean; reason?: string };
  graph?: { ready?: boolean; missing?: string[] };
  connections?: Array<{ id: string; providerUserId?: string | null; status: string }>;
}

export interface IntegrationStatus {
  microsoft?: ProviderReadiness;
  google?: ProviderReadiness;
}

type Kind = 'microsoft' | 'google' | 'imap';

interface DuplicateInfo {
  accountId: string;
  transport: string;
  address: string;
  provider: 'microsoft' | 'google';
}

interface Props {
  status: IntegrationStatus | null;
  /** The account list is refreshed after a mailbox is added or migrated. */
  reloadAccounts: () => void;
  /** Navigator into Settings → Integrations, for the administrator. */
  goToIntegrations: () => void;
  onChooseImap: () => void;
  onClose: () => void;
  isAdmin: boolean;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

/** The Microsoft authorization a native mailbox needs: the mail scopes, through the provider flow. */
export const MICROSOFT_MAIL_AUTHORIZE_PATH = '/oauth/provider/microsoft?purpose=mail_migration';
/** The Google authorization a native mailbox needs: the Gmail scope, through the browser flow. */
export const GOOGLE_MAIL_AUTHORIZE_PATH = '/oauth/google?purpose=new_account';

export default function AddAccountFlow({ status, reloadAccounts, goToIntegrations, onChooseImap, onClose, isAdmin, t }: Props) {
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<{ flowId?: string; userCode?: string; verificationUri?: string } | null>(null);

  const microsoft = status?.microsoft;
  const google = status?.google;
  const microsoftBrowserReady = microsoft?.browser?.ready === true;
  const microsoftDeviceReady = microsoft?.deviceCode?.supported !== false && microsoft?.deviceCode?.ready === true;
  const googleReady = google?.browser?.ready === true;

  const openAuthorization = useCallback((path: string) => {
    const anchor = document.createElement('a');
    anchor.href = path;
    anchor.target = '_blank';
    anchor.rel = 'opener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }, []);

  /** Turn the authorized connection into an account, and surface the "already added" answer. */
  const finishAdd = useCallback(async (provider: 'microsoft' | 'google') => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.addNativeAccount({ provider }) as { account?: { email_address?: string | null }; created?: boolean };
      setNotice(result.created === false
        ? t('admin.accounts.addAccountFlow.alreadyNative', { address: result.account?.email_address ?? '' })
        : t('admin.accounts.addAccountFlow.created', { address: result.account?.email_address ?? '' }));
      reloadAccounts();
      setKind(null);
    } catch (caught) {
      const failure = caught as { code?: string; existingAccountId?: string; existingTransport?: string; message?: string };
      if (failure.code === 'ACCOUNT_EXISTS' && failure.existingAccountId) {
        // One mailbox, one account: offer the migration that already exists for this provider.
        setDuplicate({
          accountId: failure.existingAccountId,
          transport: failure.existingTransport ?? 'imap_smtp',
          address: '',
          provider,
        });
      } else {
        setError(toAppError(caught).message);
      }
    } finally {
      setBusy(false);
    }
  }, [reloadAccounts, t]);

  const startMicrosoft = useCallback(async (method: 'browser' | 'device') => {
    setError(null);
    if (method === 'browser') {
      openAuthorization(MICROSOFT_MAIL_AUTHORIZE_PATH);
      setNotice(t('admin.accounts.addAccountFlow.finishInTab'));
      return;
    }
    setBusy(true);
    try {
      const data = await api.startProviderMsDeviceFlow('mail_migration') as { flowId?: string; userCode?: string; verificationUri?: string; interval?: number };
      setDeviceFlow({ flowId: data.flowId, userCode: data.userCode, verificationUri: data.verificationUri });
      const intervalMs = (Number(data.interval) > 0 ? Number(data.interval) : 5) * 1000;
      const poll = setInterval(async () => {
        try {
          const result = await api.pollProviderMsDeviceFlow(String(data.flowId)) as { status?: string };
          if (result.status === 'pending') return;
          clearInterval(poll);
          setDeviceFlow(null);
          if (result.status === 'success') await finishAdd('microsoft');
          else setError(t('admin.accounts.addAccountFlow.authorizationFailed'));
        } catch {
          clearInterval(poll);
          setDeviceFlow(null);
          setError(t('admin.accounts.addAccountFlow.authorizationFailed'));
        }
      }, intervalMs);
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [finishAdd, openAuthorization, t]);

  const startGoogle = useCallback(() => {
    setError(null);
    openAuthorization(GOOGLE_MAIL_AUTHORIZE_PATH);
    setNotice(t('admin.accounts.addAccountFlow.finishInTab'));
  }, [openAuthorization, t]);

  const migrateDuplicate = useCallback(async () => {
    if (!duplicate) return;
    setBusy(true);
    setError(null);
    try {
      await api.migrateAccount(duplicate.accountId, {});
      setNotice(t('admin.accounts.addAccountFlow.migrated'));
      setDuplicate(null);
      reloadAccounts();
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [duplicate, reloadAccounts, t]);

  const setupHint = (provider: 'microsoft' | 'google') => (
    <div data-testid={`add-account-setup-hint-${provider}`} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      {t(`admin.accounts.addAccountFlow.${provider}NotConfigured`)}
      {isAdmin ? (
        <button
          type="button"
          data-testid={`add-account-goto-integrations-${provider}`}
          onClick={goToIntegrations}
          style={{ marginLeft: 8, padding: '4px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
        >
          {t('admin.accounts.addAccountFlow.configureProvider')}
        </button>
      ) : null}
    </div>
  );

  return (
    <div data-testid="add-account-flow" style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)', padding: 14, maxWidth: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{t('admin.accounts.addAccountFlow.title')}</strong>
        <button type="button" data-testid="add-account-close" onClick={onClose} style={{ background: 'none', border: 0, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>
          {t('admin.accounts.addAccountFlow.cancel')}
        </button>
      </div>

      {duplicate ? (
        <div data-testid="add-account-duplicate" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6 }}>
          <div>{t('admin.accounts.addAccountFlow.duplicate', { address: duplicate.address || t('admin.accounts.addAccountFlow.thisMailbox') })}</div>
          <button
            type="button"
            data-testid="add-account-duplicate-migrate"
            disabled={busy}
            onClick={migrateDuplicate}
            style={{ marginTop: 6, padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: 'var(--accent-text)', fontSize: 12, cursor: 'pointer' }}
          >
            {duplicate.provider === 'microsoft' ? t('admin.accounts.addAccountFlow.migrateMicrosoft') : t('admin.accounts.addAccountFlow.migrateGoogle')}
          </button>
        </div>
      ) : kind === null ? (
        <div data-testid="add-account-choices" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 8, marginTop: 10 }}>
          {([
            { key: 'microsoft' as const, label: t('admin.accounts.addAccountFlow.microsoft'), description: t('admin.accounts.addAccountFlow.microsoftDescription'), action: t('admin.accounts.addAccountFlow.connectMicrosoft') },
            { key: 'google' as const, label: t('admin.accounts.addAccountFlow.google'), description: t('admin.accounts.addAccountFlow.googleDescription'), action: t('admin.accounts.addAccountFlow.connectGoogle') },
            { key: 'imap' as const, label: t('admin.accounts.addAccountFlow.imap'), description: t('admin.accounts.addAccountFlow.imapDescription'), action: t('admin.accounts.addAccountFlow.configureImap') },
          ]).map(choice => (
            <button
              key={choice.key}
              type="button"
              data-testid={`add-account-choice-${choice.key}`}
              onClick={() => { setError(null); setNotice(null); if (choice.key === 'imap') onChooseImap(); else setKind(choice.key); }}
              style={{ textAlign: 'start', padding: '10px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', cursor: 'pointer', minWidth: 0 }}
            >
              <div style={{ fontSize: 13, fontWeight: 600 }}>{choice.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{choice.description}</div>
              <div style={{ fontSize: 12, color: 'var(--accent)', marginTop: 6 }}>{choice.action}</div>
            </button>
          ))}
        </div>
      ) : kind === 'microsoft' ? (
        <div data-testid="add-account-microsoft" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ color: 'var(--text-secondary)' }}>{t('admin.accounts.addAccountFlow.microsoftDescription')}</div>
          {microsoftBrowserReady ? (
            <button
              type="button"
              data-testid="add-account-microsoft-browser"
              disabled={busy}
              onClick={() => { void startMicrosoft('browser'); }}
              style={{ marginTop: 6, padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: 'var(--accent-text)', fontSize: 12, cursor: 'pointer' }}
            >
              {t('admin.accounts.addAccountFlow.connectMicrosoft')}
            </button>
          ) : setupHint('microsoft')}
          {microsoftDeviceReady && (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                data-testid="add-account-microsoft-device"
                disabled={busy}
                onClick={() => { void startMicrosoft('device'); }}
                style={{ padding: '6px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
              >
                {t('admin.accounts.addAccountFlow.connectMicrosoftDevice')}
              </button>
              {deviceFlow && (
                <div data-testid="add-account-microsoft-device-code" style={{ marginTop: 6 }}>
                  {t('admin.accounts.addAccountFlow.deviceCodeHint', { code: deviceFlow.userCode ?? '', url: deviceFlow.verificationUri ?? '' })}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            data-testid="add-account-microsoft-finish"
            disabled={busy}
            onClick={() => { void finishAdd('microsoft'); }}
            style={{ marginTop: 8, padding: '6px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
          >
            {t('admin.accounts.addAccountFlow.finishMicrosoft')}
          </button>
        </div>
      ) : (
        <div data-testid="add-account-google" style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7 }}>
          <div style={{ color: 'var(--text-secondary)' }}>{t('admin.accounts.addAccountFlow.googleDescription')}</div>
          {googleReady ? (
            <button
              type="button"
              data-testid="add-account-google-browser"
              disabled={busy}
              onClick={startGoogle}
              style={{ marginTop: 6, padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 7, color: 'var(--accent-text)', fontSize: 12, cursor: 'pointer' }}
            >
              {t('admin.accounts.addAccountFlow.connectGoogle')}
            </button>
          ) : setupHint('google')}
          <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>{t('admin.accounts.addAccountFlow.googleImapAlternative')}</div>
          <button
            type="button"
            data-testid="add-account-google-imap"
            onClick={onChooseImap}
            style={{ marginTop: 6, padding: '6px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
          >
            {t('admin.accounts.addAccountFlow.configureGoogleImap')}
          </button>
          <button
            type="button"
            data-testid="add-account-google-finish"
            disabled={busy}
            onClick={() => { void finishAdd('google'); }}
            style={{ marginTop: 8, marginLeft: 6, padding: '6px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
          >
            {t('admin.accounts.addAccountFlow.finishGoogle')}
          </button>
        </div>
      )}

      {notice && <div data-testid="add-account-notice" style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</div>}
      {error && <div data-testid="add-account-error" style={{ marginTop: 8, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>{t('admin.accounts.addAccountFlow.providerConfigNote')}</div>
    </div>
  );
}
