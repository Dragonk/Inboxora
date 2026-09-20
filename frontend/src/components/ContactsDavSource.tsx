import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api.ts';
import { toAppError } from '../utils/errors.ts';
import { Button } from './ui.tsx';

/**
 * The CardDAV contact source, managed from **Contacts**.
 *
 * A calendar can be added from the calendar screen's own sources dialog, and a contacts source belongs in the
 * same place for the same reason: it is a source of the feature the user is looking at, not an installation
 * setting. Its strings are the ones the settings screen already uses, so the concept is named identically in
 * both places.
 *
 * The pull is one-way and read-only: the source is the owner of its books, and Inboxora writes nothing back to
 * it.
 */

interface DavStatus {
  connected?: boolean;
  username?: string;
  serverUrl?: string;
  contactCount?: number;
  bookCount?: number;
  lastSyncAt?: string;
  lastError?: string;
  intervalMin?: number | string;
  [key: string]: unknown;
}

const rowStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
const metaStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', margin: '2px 0' };
const inputStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
};

export default function ContactsDavSource({ t }: { t: (key: string, values?: Record<string, unknown>) => string }) {
  const [status, setStatus] = useState<DavStatus | null>(null);
  const [form, setForm] = useState({ serverUrl: '', username: '', password: '', intervalMin: 60 });
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.carddav.status().then((data: DavStatus) => setStatus(data)).catch(() => setStatus({ connected: false }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const connected = status?.connected === true;

  const connect = async () => {
    setBusy('connect');
    setError('');
    try {
      const data = await api.carddav.connect({
        serverUrl: form.serverUrl.trim(),
        username: form.username.trim(),
        password: form.password,
        dupMode: 'separate',
        intervalMin: Number(form.intervalMin),
      }) as DavStatus;
      setStatus(data);
      setForm(current => ({ ...current, password: '' }));
    } catch (caught) {
      setError(toAppError(caught).message || t('admin.integrations.carddav.connectFailed'));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError('');
    try {
      const result = await api.carddav.sync() as { ok?: boolean; error?: string; status?: DavStatus };
      if (result.status) setStatus(result.status);
      if (!result.ok && result.error) setError(result.error);
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setError('');
    try {
      await api.carddav.disconnect();
      setStatus({ connected: false });
    } catch (caught) {
      setError(toAppError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="contacts-manager-carddav">
      {status === null && <p style={metaStyle}>{t('common.loading')}</p>}

      {status !== null && connected && (
        <>
          <p style={metaStyle} data-testid="contacts-manager-carddav-status">
            {t('admin.integrations.carddav.connected')}
            {typeof status.serverUrl === 'string' && status.serverUrl ? ` · ${status.serverUrl}` : ''}
          </p>
          <p style={metaStyle}>
            {t('admin.integrations.carddav.summary', {
              contacts: status.contactCount ?? 0,
              books: status.bookCount ?? 0,
            })}
          </p>
          <p style={metaStyle}>
            {t('admin.integrations.carddav.lastSync', {
              when: status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : t('common.never'),
            })}
          </p>
          <div style={rowStyle}>
            <Button data-testid="contacts-manager-carddav-sync" disabled={busy !== null} onClick={sync}>
              {busy === 'sync' ? t('admin.integrations.carddav.syncing') : t('admin.integrations.carddav.sync')}
            </Button>
            <Button data-testid="contacts-manager-carddav-disconnect" disabled={busy !== null} onClick={disconnect}>
              {busy === 'disconnect' ? t('admin.integrations.carddav.disconnecting') : t('admin.integrations.carddav.disconnect')}
            </Button>
          </div>
        </>
      )}

      {status !== null && !connected && (
        <>
          <p style={metaStyle}>{t('admin.integrations.carddav.description')}</p>
          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ fontSize: 12 }}>
              {t('admin.integrations.carddav.serverUrl')}
              <input data-testid="contacts-manager-carddav-url" style={inputStyle} value={form.serverUrl}
                onChange={event => setForm(current => ({ ...current, serverUrl: event.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>
              {t('admin.integrations.carddav.username')}
              <input data-testid="contacts-manager-carddav-username" style={inputStyle} value={form.username}
                onChange={event => setForm(current => ({ ...current, username: event.target.value }))} />
            </label>
            <label style={{ fontSize: 12 }}>
              {t('admin.integrations.carddav.password')}
              <input data-testid="contacts-manager-carddav-password" type="password" autoComplete="new-password" style={inputStyle} value={form.password}
                onChange={event => setForm(current => ({ ...current, password: event.target.value }))} />
            </label>
          </div>
          <div style={{ ...rowStyle, marginTop: 8 }}>
            <Button
              data-testid="contacts-manager-carddav-connect"
              variant="primary"
              disabled={busy !== null || !form.serverUrl.trim() || !form.username.trim() || !form.password}
              onClick={connect}
            >
              {busy === 'connect' ? t('admin.integrations.carddav.connecting') : t('admin.integrations.carddav.connect')}
            </Button>
          </div>
        </>
      )}

      {error && <div role="alert" className="ui-alert" data-testid="contacts-manager-carddav-error">{error}</div>}
    </div>
  );
}
