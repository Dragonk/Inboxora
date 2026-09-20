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
  mail: { transport: string; nativeTransport: string | null; native: boolean; migrationAvailable: boolean };
  calendar: { authorized: boolean; connectionId: string | null; collections: Array<{ id: string; kind: string; enabled: boolean }> } | null;
  contacts: { authorized: boolean; connectionId: string | null; collections: Array<{ id: string; kind: string; enabled: boolean }> } | null;
  push: { mail: string; calendar: string; contacts: string };
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
export function authorizationPath(input: { provider: 'google' | 'microsoft'; service: 'mail' | 'calendar' | 'contacts' }): string {
  const purpose = input.service === 'mail' ? 'mail_migration' : input.service === 'calendar' ? 'calendar_enable' : 'contacts_enable';
  return input.provider === 'google'
    ? `/oauth/google?purpose=${purpose}`
    : `/oauth/provider/microsoft?purpose=${purpose}`;
}

export default function AccountProviderServices({ accountId, reload, t }: Props) {
  const [features, setFeatures] = useState<AccountProviderFeatures | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.accountProviderFeatures(accountId)
      .then((data: AccountProviderFeatures) => setFeatures(data))
      .catch(() => { /* the card simply shows no services section when it cannot be read */ });
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  const authorize = useCallback((provider: 'google' | 'microsoft', service: 'calendar' | 'contacts' | 'mail') => {
    const anchor = document.createElement('a');
    anchor.href = authorizationPath({ provider, service });
    anchor.target = '_blank';
    anchor.rel = 'opener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setNotice(t('admin.accounts.services.finishInTab'));
  }, [t]);

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

  const serviceRow = (label: string, connected: boolean, onConnect: () => void, extra?: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
      <span style={{ minWidth: 92, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: connected ? 'var(--green)' : 'var(--text-tertiary)' }}>
        {connected ? t('admin.accounts.services.connected') : t('admin.accounts.services.notConnected')}
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
        features.calendar?.authorized ? t('admin.accounts.services.collections', { count: features.calendar.collections.length }) : undefined)}
      {serviceRow(t('admin.accounts.services.contacts'), features.contacts?.authorized === true,
        () => authorize(provider, 'contacts'))}

      <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
        {t('admin.accounts.services.instantSync')}: {t('admin.accounts.services.mail')} {features.push.mail} · {t('admin.accounts.services.calendar')} {features.push.calendar} · {t('admin.accounts.services.contacts')} {features.push.contacts}
      </div>

      {notice && <div data-testid="account-services-notice" style={{ color: 'var(--text-secondary)' }}>{notice}</div>}
      {error && <div data-testid="account-services-error" style={{ color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
