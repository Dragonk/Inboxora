import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
import DavCopyValue from '../DavCopyValue.tsx';
import { getAuthEpoch, isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import { MCP_SCOPE_KEYS, MCP_STATE_KEYS, mcpRequest, newMcpGrant, emptyResources, type McpConfig, type McpResources, type McpGrant, type McpOperation } from '../../utils/mcp.ts';
import McpGrantForm from './McpGrantForm.tsx';
import './mcp.css';

export default function McpSettings() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [resources, setResources] = useState<McpResources>(emptyResources);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [operations, setOperations] = useState<McpOperation[]>([]);
  const [form, setForm] = useState(newMcpGrant);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState('');
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const epoch = getAuthEpoch(); let current = true;
    setLoading(true); setError('');
    Promise.all([
      mcpRequest<McpConfig>('GET','/config'), mcpRequest<McpResources>('GET','/resources'),
      mcpRequest<{ grants: McpGrant[] }>('GET','/grants'), mcpRequest<{ operations: McpOperation[] }>('GET','/operations'),
    ]).then(([settings, choices, integrations, history]) => {
      if (!current || !isCurrentAuthEpoch(epoch)) return;
      setConfig(settings); setResources(choices); setGrants(integrations.grants); setOperations(history.operations);
    }).catch(() => { if (current && isCurrentAuthEpoch(epoch)) setError(t('mcp.loadError')); })
      .finally(() => { if (current && isCurrentAuthEpoch(epoch)) setLoading(false); });
    return () => { current = false; };
  }, [reload, t]);
  const create = async () => {
    if (busy) return;
    const epoch = getAuthEpoch(); setBusy(true); setError(''); setSecret('');
    try {
      const result = await mcpRequest<{ token: string }>('POST','/tokens',form);
      if (!mounted.current || !isCurrentAuthEpoch(epoch)) return;
      setSecret(result.token); setCreating(false); setForm(newMcpGrant()); setReload(value => value + 1);
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.saveError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
  const revoke = async (id: string) => {
    const epoch = getAuthEpoch(); setBusy(true); setError('');
    try { await mcpRequest('DELETE', `/grants/${encodeURIComponent(id)}`); if (mounted.current && isCurrentAuthEpoch(epoch)) { setRevokeId(null); setSecret(''); setReload(value => value + 1); } }
    catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.saveError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
  return <section className="mcp-panel" aria-label={t('mcp.title')}>
    <h2>{t('mcp.title')}</h2><p>{t('mcp.description')}</p>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    <div className="mcp-actions"><Button disabled={busy || loading} onClick={() => setReload(value => value + 1)}>{t('mcp.refresh')}</Button></div>
    {loading && !config && <p role="status">{t('mcp.loading')}</p>}
    {config && <>
      {(!config.enabled || config.configurationError) && <div className="mcp-warning"><p>{t('mcp.disabled')}</p><pre className="mcp-code">{'MCP_ENABLED=true\nAPP_URL=https://inboxora.example.com'}</pre></div>}
      {config.endpoint && <div className="mcp-card"><strong>{t('mcp.endpoint')}</strong><DavCopyValue label={t('mcp.endpoint')} value={config.endpoint}/><p>{t('mcp.oauthHelp')}</p><p>{t('mcp.tokenHelp')}</p></div>}
      <div className="mcp-actions"><Button disabled={!config.enabled || config.configurationError || busy || loading} onClick={() => { setCreating(value => !value); setSecret(''); }}>{creating ? t('mcp.cancel') : t('mcp.createToken')}</Button></div>
      {creating && <div className="mcp-card"><McpGrantForm value={form} onChange={setForm} resources={resources} disabled={busy}/>
        <div className="mcp-actions"><Button variant="primary" disabled={busy || !form.name.trim() || !form.scopes.length || form.expiresInDays < 1 || form.expiresInDays > 365} onClick={() => void create()}>{t('mcp.createToken')}</Button></div></div>}
      {secret && <div className="mcp-card" role="status"><h3>{t('mcp.tokenCreated')}</h3><p className="mcp-warning">{t('mcp.tokenOnce')}</p><DavCopyValue label={t('mcp.tokenCreated')} value={secret}/><div className="mcp-actions"><Button onClick={() => setSecret('')}>{t('mcp.hideToken')}</Button></div></div>}
      <h3>{t('mcp.integrations')}</h3>{!grants.length && <p>{t('mcp.noIntegrations')}</p>}
      {grants.map(grant => <article key={grant.id} className="mcp-card"><div className="mcp-row"><strong>{grant.name}</strong>
        <span>{grant.revoked_at ? t('mcp.revoked') : new Date(grant.expires_at).getTime() <= Date.now() ? t('mcp.expired') : t('mcp.active')}</span></div>
        <p>{grant.scopes.map(scope => t(MCP_SCOPE_KEYS[scope])).join(' · ')}</p>
        <small>{t('mcp.expiresAt', { date: new Date(grant.expires_at).toLocaleString() })}</small>
        <details><summary>{t('mcp.permissions')}</summary><pre className="mcp-code">{JSON.stringify(grant.restrictions, null, 2)}</pre><p>{grant.require_confirmation ? t('mcp.confirmWrites') : t('mcp.unattendedWarning')}</p></details>
        {!grant.revoked_at && <div className="mcp-actions">{revokeId === grant.id ? <><span>{t('mcp.revokeQuestion')}</span><Button variant="danger" disabled={busy} onClick={() => void revoke(grant.id)}>{t('mcp.revoke')}</Button><Button disabled={busy} onClick={() => setRevokeId(null)}>{t('mcp.cancel')}</Button></>
          : <Button disabled={busy} onClick={() => setRevokeId(grant.id)}>{t('mcp.revoke')}</Button>}</div>}
      </article>)}
      <h3>{t('mcp.operations')}</h3>{!operations.length && <p>{t('mcp.noOperations')}</p>}
      {operations.map(operation => <article className="mcp-card" key={operation.id}><div className="mcp-row"><span>{operation.integration_name} · <code>{operation.tool}</code></span>
        <span>{t(MCP_STATE_KEYS[operation.state] ?? 'mcp.states.uncertain')}</span></div><a href={`/ai/mcp/confirm/${encodeURIComponent(operation.id)}`} target="_blank" rel="noopener noreferrer">{t('mcp.review')}</a></article>)}
    </>}
  </section>;
}
