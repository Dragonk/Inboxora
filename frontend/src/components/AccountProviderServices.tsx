import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.ts';
import { toAppError } from '../utils/errors.ts';

/**
 * The provider services of **one account**, shown on that account's own card.
 *
 * This is the account-centric half of the settings split: Integrations configures the provider application
 * and the global webhook infrastructure, while this section answers, for this mailbox, "which transport does
 * my mail use, can it move to the provider API, are my calendar and contacts connected, and is instant
 * synchronisation on?". A provider connection is a user's authorization for a specific mailbox, so what is
 * shown here is resolved by identity (`provider_user_id` = the account's address), never by which connection
 * happens to be newest.
 */

export interface AccountProviderFeatures {
  accountId: string;
  provider: 'google' | 'microsoft' | null;
  mail: { transport: string; nativeTransport: string | null; native: boolean; migrationAvailable: boolean; authorized?: boolean; requiredScopes?: string[]; grantedScopes?: string[]; missingScopes?: string[]; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null };
  calendar: { authorized: boolean; connectionId: string | null; collections: Array<{ id: string; kind: string; enabled: boolean }>; requiredScopes?: string[]; grantedScopes?: string[]; missingScopes?: string[]; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null } | null;
  contacts: { authorized: boolean; connectionId: string | null; collections: Array<{ id: string; kind: string; enabled: boolean }>; requiredScopes?: string[]; grantedScopes?: string[]; missingScopes?: string[]; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null } | null;
  push: { mail: string; calendar: string; contacts: string };
}

/** What the last recorded run of one feature did, as the diagnostics endpoint reports it. */
export interface AccountFeatureDiagnostic {
  lastSuccessfulSync: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  cursorPresent: boolean;
  authorized: boolean;
  requiredScopes: string[];
  missingScopes: string[];
}

export interface AccountProviderDiagnostics {
  accountId: string;
  provider: 'google' | 'microsoft' | null;
  transport: string;
  connection: { provider: 'google' | 'microsoft'; identity: string | null; status: string } | null;
  mail: AccountFeatureDiagnostic & { transport: string; push: string; scheduler: string };
  calendar: AccountFeatureDiagnostic & { collections: number; push: string };
  contacts: AccountFeatureDiagnostic & { collections: number; push: string };
}

interface Props {
  accountId: string;
  /** Called after a successful migration or authorization, so the card refetches. */
  reload: () => void;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

/** The human name of a transport, which is what the card shows instead of an IMAP host and port. */
export function transportLabel(transport: string): string {
  if (transport === 'microsoft_graph') return 'Microsoft Graph';
  if (transport === 'gmail_api') return 'Gmail API';
  return 'IMAP/SMTP';
}

/** The authorization a "connect this service" action starts, per provider and service. */
export function authorizationPath(input: { provider: 'google' | 'microsoft'; service: 'mail' | 'calendar' | 'contacts'; accountId?: string }): string {
  const purpose = input.service === 'mail' ? 'mail_migration' : input.service === 'calendar' ? 'calendar_enable' : 'contacts_enable';
  const account = input.accountId ? `&accountId=${encodeURIComponent(input.accountId)}` : '';
  return input.provider === 'google'
    ? `/oauth/google?purpose=${purpose}${account}`
    : `/oauth/provider/microsoft?purpose=${purpose}${account}`;
}

export default function AccountProviderServices({ accountId, reload, t }: Props) {
  const [features, setFeatures] = useState<AccountProviderFeatures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<AccountProviderDiagnostics | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const load = useCallback(() => {
    api.accountProviderFeatures(accountId)
      .then((data: AccountProviderFeatures) => setFeatures(data))
      .catch(() => { /* the card simply shows no services section when it cannot be read */ });
    // Read with the features, so the section never shows a state the buttons above contradict.
    api.accountProviderDiagnostics(accountId)
      .then((data: AccountProviderDiagnostics) => setDiagnostics(data))
      .catch(() => setDiagnostics(null));
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  /**
   * React to the OAuth window that was opened from this card.
   *
   * The provider callback hands the opener the provider, the purpose, the account and the outcome of the first
   * synchronisation — never a token. The card refetches only when the result is about **its own** account and
   * the message comes from this origin, so an authorization for another mailbox cannot make this card claim a
   * success it does not have. The "finish in the new tab" notice is cleared at the same moment: the user is
   * back, and the state they are looking at is now current.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        type?: unknown; provider?: unknown; purpose?: unknown; accountId?: unknown;
        authorized?: unknown; synchronized?: unknown; syncErrorCode?: unknown;
      } | null;
      if (!data || data.type !== 'oauth_success') return;
      if (typeof data.accountId !== 'string' || data.accountId !== accountId) return;
      setNotice(null);
      load();
      reload();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [accountId, load, reload]);

  const authorize = useCallback((provider: 'google' | 'microsoft', service: 'calendar' | 'contacts' | 'mail') => {
    const anchor = document.createElement('a');
    anchor.href = authorizationPath({ provider, service, accountId });
    anchor.target = '_blank';
    anchor.rel = 'opener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setNotice(t('admin.accounts.services.finishInTab'));
  }, [t, accountId]);

  const migrate = useCallback(async (provider: 'google' | 'microsoft') => {
    setBusy(true);
    setError(null);
    try {
      await api.migrateAccount(accountId, { provider });
      setNotice(t('admin.accounts.services.migrated'));
      load();
      reload();
    } catch (caught) {
      const failure = caught as { code?: string; message?: string };
      // The authorization is the step that is missing, so the button starts it and the user comes back here.
      if (failure.code === 'PROVIDER_AUTH_REQUIRED') {
        authorize(provider, 'mail');
        return;
      }
      setError(toAppError(caught).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, authorize, load, reload, t]);

  if (!features?.provider) return null;
  const provider = features.provider;
  const providerName = provider === 'google' ? t('admin.accounts.services.google') : t('admin.accounts.services.microsoft');

  /**
   * The four states a service row can be in.
   *
   * Authorization and synchronization are separate facts, and the row must not collapse them: a feature whose
   * grant is stored but whose first run failed is **connected with a synchronization failure**, not
   * "not connected" — that wording sends the user to reconnect an account that is already authorized.
   */
  const serviceStatus = (feature: { authorized: boolean; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null } | null | undefined): string => {
    if (!feature?.authorized) return t('admin.accounts.services.notConnected');
    if (feature.synchronized === true) return t('admin.accounts.services.connected');
    if (feature.syncErrorCode) return t('admin.accounts.services.syncFailed', { code: feature.syncErrorCode });
    return t('admin.accounts.services.syncPending');
  };

  const serviceRow = (label: string, connected: boolean, onConnect: () => void, extra?: string, feature?: { authorized: boolean; synchronized?: boolean; syncPending?: boolean; syncErrorCode?: string | null } | null) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
      <span style={{ minWidth: 92, color: 'var(--text-secondary)' }}>{label}</span>
      <span
        data-testid={`account-service-status-${label.toLowerCase()}`}
        data-synchronized={connected && feature?.synchronized === true ? 'true' : 'false'}
        style={{ color: connected ? (feature?.syncErrorCode ? 'var(--red, #f87171)' : 'var(--green)') : 'var(--text-tertiary)' }}
      >
        {serviceStatus(feature ?? { authorized: connected })}
      </span>
      {!connected && (
        <button
          type="button"
          data-testid={`account-service-connect-${label.toLowerCase()}`}
          onClick={onConnect}
          style={{ padding: '3px 10px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer' }}
        >
          {t('admin.accounts.services.connect')}
        </button>
      )}
      {extra && <span style={{ color: 'var(--text-tertiary)' }}>{extra}</span>}
    </div>
  );

  /**
   * The diagnostics lines for one feature: whether it is authorized, what it is missing, when it last
   * succeeded and what its last error was. Only names and times — the server sends no token.
   */
  const diagnosticsFeature = (
    // An explicit slug, not the translated label: a test id has to be stable in every language.
    slug: 'mail' | 'calendar' | 'contacts',
    label: string,
    feature: AccountFeatureDiagnostic,
    extra?: React.ReactNode,
  ) => (
    <div data-testid={`account-diagnostics-${slug}`} style={{ marginTop: 6 }}>
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</div>
      <div>{t('admin.accounts.diagnostics.authorized')}: {feature.authorized ? t('admin.accounts.diagnostics.yes') : t('admin.accounts.diagnostics.no')}</div>
      {!feature.authorized && feature.missingScopes.length > 0 && (
        <div data-testid={`account-diagnostics-missing-${slug}`}>
          {t('admin.accounts.diagnostics.missingScopes')}: {feature.missingScopes.join(', ')}
        </div>
      )}
      <div>{t('admin.accounts.diagnostics.lastSuccess')}: {feature.lastSuccessfulSync ? new Date(feature.lastSuccessfulSync).toLocaleString() : t('admin.accounts.diagnostics.never')}</div>
      {feature.lastErrorCode && (
        <div data-testid={`account-diagnostics-error-${slug}`} style={{ color: 'var(--red, #f87171)' }}>
          {t('admin.accounts.diagnostics.lastError')}: {feature.lastErrorCode}
        </div>
      )}
      {extra}
    </div>
  );

  return (
    <div data-testid="account-provider-services" style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)', fontSize: 12, lineHeight: 1.7, minWidth: 0 }}>
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('admin.accounts.services.title', { provider: providerName })}</div>

      <div style={{ marginTop: 4 }}>
        <span style={{ color: 'var(--text-secondary)' }}>{t('admin.accounts.services.mail')}: </span>
        <span data-testid="account-transport">{transportLabel(features.mail.transport)}</span>
        {features.mail.migrationAvailable && (
          <button
            type="button"
            data-testid="account-migrate-native"
            disabled={busy}
            onClick={() => { void migrate(provider); }}
            style={{ marginLeft: 8, padding: '3px 10px', background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'var(--accent-text)', fontSize: 12, cursor: 'pointer' }}
          >
            {provider === 'google' ? t('admin.accounts.services.migrateGoogle') : t('admin.accounts.services.migrateMicrosoft')}
          </button>
        )}
      </div>

      {serviceRow(t('admin.accounts.services.calendar'), features.calendar?.authorized === true,
        () => authorize(provider, 'calendar'),
        features.calendar?.authorized ? t('admin.accounts.services.collections', { count: features.calendar.collections.length }) : undefined,
        features.calendar)}
      {serviceRow(t('admin.accounts.services.contacts'), features.contacts?.authorized === true,
        () => authorize(provider, 'contacts'),
        undefined,
        features.contacts)}

      <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
        {t('admin.accounts.services.instantSync')}: {t('admin.accounts.services.mail')} {features.push.mail} · {t('admin.accounts.services.calendar')} {features.push.calendar} · {t('admin.accounts.services.contacts')} {features.push.contacts}
      </div>

      {/* Diagnostics: collapsed by default, because the card's job is the actions. Everything here comes
          from the server for this account, and nothing in it is a token or a secret. */}
      {diagnostics && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            data-testid="account-diagnostics-toggle"
            aria-expanded={diagnosticsOpen}
            onClick={() => setDiagnosticsOpen(open => !open)}
            style={{ background: 'none', border: 0, padding: 0, color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            {diagnosticsOpen ? '▾' : '▸'} {t('admin.accounts.diagnostics.title')}
          </button>
          {diagnosticsOpen && (
            <div data-testid="account-diagnostics" style={{ marginTop: 6, color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
              <div data-testid="account-diagnostics-connection">
                <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{t('admin.accounts.diagnostics.connection')}</div>
                <div>{t('admin.accounts.diagnostics.provider')}: {diagnostics.provider ?? t('admin.accounts.diagnostics.none')}</div>
                <div>{t('admin.accounts.diagnostics.identity')}: {diagnostics.connection?.identity ?? t('admin.accounts.diagnostics.none')}</div>
                <div data-testid="account-diagnostics-connection-status">
                  {t('admin.accounts.diagnostics.status')}: {diagnostics.connection?.status ?? t('admin.accounts.diagnostics.none')}
                </div>
              </div>
              {diagnosticsFeature('mail', t('admin.accounts.services.mail'), diagnostics.mail, (
                <>
                  <div>{t('admin.accounts.diagnostics.transport')}: {transportLabel(diagnostics.mail.transport)}</div>
                  <div>{t('admin.accounts.diagnostics.cursor')}: {diagnostics.mail.cursorPresent ? t('admin.accounts.diagnostics.yes') : t('admin.accounts.diagnostics.no')}</div>
                  <div>{t('admin.accounts.diagnostics.push')}: {diagnostics.mail.push}</div>
                  <div>{t('admin.accounts.diagnostics.scheduler')}: {diagnostics.mail.scheduler}</div>
                </>
              ))}
              {diagnosticsFeature('calendar', t('admin.accounts.services.calendar'), diagnostics.calendar, (
                <>
                  <div>{t('admin.accounts.diagnostics.collections')}: {diagnostics.calendar.collections}</div>
                  <div>{t('admin.accounts.diagnostics.push')}: {diagnostics.calendar.push}</div>
                </>
              ))}
              {diagnosticsFeature('contacts', t('admin.accounts.services.contacts'), diagnostics.contacts, (
                <>
                  <div>{t('admin.accounts.diagnostics.addressBooks')}: {diagnostics.contacts.collections}</div>
                  <div>{t('admin.accounts.diagnostics.push')}: {diagnostics.contacts.push}</div>
                </>
              ))}
            </div>
          )}
        </div>
      )}

      {notice && <div data-testid="account-services-notice" style={{ color: 'var(--text-secondary)' }}>{notice}</div>}
      {error && <div data-testid="account-services-error" style={{ color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
