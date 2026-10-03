import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
import DavCopyValue from '../DavCopyValue.tsx';
import { getAuthEpoch, isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import {
  MCP_SCOPE_KEYS, MCP_STATE_KEYS, mcpRequest, newMcpGrant, emptyResources,
  type McpConfig, type McpResources, type McpGrant, type McpGrantInput, type McpOperation,
} from '../../utils/mcp.ts';
import McpGrantForm from './McpGrantForm.tsx';
import './mcp.css';

function remainingDays(expiresAt: string): number {
  return Math.max(1, Math.min(365, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000)));
}
function grantFormValue(grant: McpGrant): McpGrantInput {
  return {
    name: grant.name,
    scopes: [...grant.scopes],
    restrictions: grant.restrictions,
    requireConfirmation: grant.require_confirmation,
    expiresInDays: remainingDays(grant.expires_at),
  };
}
function activeGrant(grant: McpGrant): boolean {
  return !grant.revoked_at && new Date(grant.expires_at).getTime() > Date.now();
}

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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<McpGrantInput | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [reload, setReload] = useState(0);
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
    const epoch = getAuthEpoch(); setBusy(true); setError(''); setNotice(''); setSecret('');
    try {
      const result = await mcpRequest<{ token: string }>('POST','/tokens',form);
      if (!mounted.current || !isCurrentAuthEpoch(epoch)) return;
      setSecret(result.token); setCreating(false); setForm(newMcpGrant()); setReload(value => value + 1);
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.saveError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
  const revoke = async (id: string) => {
    const epoch = getAuthEpoch(); setBusy(true); setError(''); setNotice('');
    try {
      await mcpRequest('DELETE', `/grants/${encodeURIComponent(id)}`);
      if (mounted.current && isCurrentAuthEpoch(epoch)) {
        setRevokeId(null); setEditingId(null); setEditForm(null); setSecret(''); setReload(value => value + 1);
      }
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.saveError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
  const openPermissions = (grant: McpGrant) => {
    setRevokeId(null); setEditingId(current => current === grant.id ? null : grant.id); setEditForm(grantFormValue(grant)); setNotice('');
  };
  const savePermissions = async (grant: McpGrant) => {
    if (!editForm || busy || !activeGrant(grant) || !editForm.scopes.length) return;
    const epoch = getAuthEpoch(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await mcpRequest<{ grant: McpGrant }>('POST', `/grants/${encodeURIComponent(grant.id)}`, {
        scopes: editForm.scopes, restrictions: editForm.restrictions, requireConfirmation: editForm.requireConfirmation,
      });
      if (!mounted.current || !isCurrentAuthEpoch(epoch)) return;
      setGrants(current => current.map(item => item.id === grant.id ? result.grant : item));
      setEditingId(null); setEditForm(null); setNotice(t('mcp.permissionsSaved')); setReload(value => value + 1);
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.saveError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };

  const recentOperations = useMemo(() => operations.slice(0, 20), [operations]);
  return <section className="mcp-panel mcp-settings-panel" aria-label={t('mcp.title')}>
    <div className="mcp-settings-heading">
      <div><h2>{t('mcp.title')}</h2><p>{t('mcp.description')}</p></div>
      <Button disabled={busy || loading} onClick={() => setReload(value => value + 1)}>{t('mcp.refresh')}</Button>
    </div>
    {error && <p role="alert" className="mcp-error">{error}</p>}
    {notice && <p role="status" className="mcp-success">{notice}</p>}
    {loading && !config && <p role="status">{t('mcp.loading')}</p>}
    {config && <>
      {(!config.enabled || config.configurationError) && <div className="mcp-warning"><p>{t('mcp.disabled')}</p><pre className="mcp-code">{'MCP_ENABLED=true\nAPP_URL=https://inboxora.example.com'}</pre></div>}

      <section className="mcp-settings-section">
        <h3>{t('mcp.serverSection')}</h3>
        {config.endpoint ? <><DavCopyValue label={t('mcp.endpoint')} value={config.endpoint}/><p>{t('mcp.oauthHelp')}</p><p>{t('mcp.tokenHelp')}</p></> : <p>{t('mcp.disabled')}</p>}
      </section>

      <section className="mcp-settings-section">
        <div className="mcp-settings-section-heading"><div><h3>{t('mcp.integrations')}</h3><p>{t('mcp.connectionsDescription')}</p></div>
          <Button disabled={!config.enabled || config.configurationError || busy || loading} onClick={() => { setCreating(value => !value); setSecret(''); setEditingId(null); }}>{creating ? t('mcp.cancel') : t('mcp.createToken')}</Button>
        </div>
        {creating && <div className="mcp-editor-card"><McpGrantForm value={form} onChange={setForm} resources={resources} disabled={busy}/>
          <div className="mcp-actions"><Button variant="primary" disabled={busy || !form.name.trim() || !form.scopes.length || form.expiresInDays < 1 || form.expiresInDays > 365} onClick={() => void create()}>{t('mcp.createToken')}</Button></div></div>}
        {secret && <div className="mcp-editor-card" role="status"><h3>{t('mcp.tokenCreated')}</h3><p className="mcp-warning">{t('mcp.tokenOnce')}</p><DavCopyValue label={t('mcp.tokenCreated')} value={secret}/><div className="mcp-actions"><Button onClick={() => setSecret('')}>{t('mcp.hideToken')}</Button></div></div>}
        {!grants.length && <p>{t('mcp.noIntegrations')}</p>}
        <div className="mcp-connection-list">{grants.map(grant => {
          const active = activeGrant(grant); const editing = editingId === grant.id && editForm;
          return <article key={grant.id} className="mcp-connection-card">
            <div className="mcp-row"><div><strong>{grant.name}</strong><div className="mcp-connection-meta">{t('mcp.expiresAt', { date: new Date(grant.expires_at).toLocaleString() })}</div></div>
              <span className={`mcp-status ${active ? 'mcp-status-active' : ''}`}>{grant.revoked_at ? t('mcp.revoked') : active ? t('mcp.active') : t('mcp.expired')}</span></div>
            <div className="mcp-scope-summary">{grant.scopes.map(scope => <span key={scope}>{t(MCP_SCOPE_KEYS[scope])}</span>)}</div>
            <div className="mcp-actions"><Button disabled={busy} onClick={() => openPermissions(grant)}>{editing ? t('mcp.hidePermissions') : active ? t('mcp.managePermissions') : t('mcp.viewPermissions')}</Button>
              {active && (revokeId === grant.id ? <><span className="mcp-inline-warning">{t('mcp.revokeQuestion')}</span><Button variant="danger" disabled={busy} onClick={() => void revoke(grant.id)}>{t('mcp.revoke')}</Button><Button disabled={busy} onClick={() => setRevokeId(null)}>{t('mcp.cancel')}</Button></>
                : <Button disabled={busy} onClick={() => { setRevokeId(grant.id); setEditingId(null); }}>{t('mcp.revoke')}</Button>)}</div>
            {editing && <div className="mcp-permission-editor"><McpGrantForm value={editForm} onChange={setEditForm} resources={resources} disabled={busy || !active} showIdentityFields={false}/>
              {active && <><p className="mcp-permission-note">{t('mcp.permissionsChangeWarning')}</p><div className="mcp-actions"><Button variant="primary" disabled={busy || !editForm.scopes.length} onClick={() => void savePermissions(grant)}>{t('mcp.savePermissions')}</Button><Button disabled={busy} onClick={() => { setEditingId(null); setEditForm(null); }}>{t('mcp.cancel')}</Button></div></>}</div>}
          </article>;
        })}</div>
      </section>

      <section className="mcp-settings-section">
        <h3>{t('mcp.operations')}</h3><p>{t('mcp.operationsDescription')}</p>
        {!recentOperations.length && <p>{t('mcp.noOperations')}</p>}
        <div className="mcp-operation-list">{recentOperations.map(operation => <article className="mcp-operation-row" key={operation.id}><div><strong>{operation.integration_name}</strong><small><code>{operation.tool}</code></small></div>
          <span>{t(MCP_STATE_KEYS[operation.state] ?? 'mcp.states.uncertain')}</span><a href={`/ai/mcp/confirm/${encodeURIComponent(operation.id)}`} target="_blank" rel="noopener noreferrer">{t('mcp.review')}</a></article>)}</div>
      </section>
    </>}
  </section>;
}
