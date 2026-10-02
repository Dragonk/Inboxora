import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { getAuthEpoch, isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import { clearMcpReturn, emptyResources, mcpRequest, newMcpGrant, type McpConsent, type McpOperation, type McpResources } from '../../utils/mcp.ts';
import { Button } from '../ui.tsx';
import McpGrantForm from './McpGrantForm.tsx';
import './mcp.css';

export default function McpPage() {
  const { t } = useTranslation(); const location = useLocation(); const { id } = useParams();
  const user = useStore(state => state.user);
  const authorization = location.pathname === '/ai/mcp/authorize';
  const request = new URLSearchParams(location.search).get('request');
  const [consent, setConsent] = useState<McpConsent | null>(null);
  const [operation, setOperation] = useState<McpOperation | null>(null);
  const [form, setForm] = useState(newMcpGrant);
  const [resources, setResources] = useState<McpResources>(emptyResources);
  const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false); const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; clearMcpReturn(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true; const epoch = getAuthEpoch();
    setLoading(true); setError(''); setConsent(null); setOperation(null); setReviewed(false);
    const load = async () => {
      if (authorization) {
        if (!request || !/^[A-Za-z0-9_-]{43}$/.test(request)) throw new Error('Invalid authorization request.');
        const [response, choices] = await Promise.all([mcpRequest<McpConsent>('GET', `/authorizations/${request}`), mcpRequest<McpResources>('GET','/resources')]);
        if (!current || !isCurrentAuthEpoch(epoch)) return;
        setConsent(response); setResources(choices); setForm({ ...newMcpGrant(response.name), scopes: response.scopes.filter(scope => scope.endsWith('.read')) });
      } else {
        if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid operation.');
        const response = await mcpRequest<McpOperation>('GET', `/operations/${id}`);
        if (current && isCurrentAuthEpoch(epoch)) setOperation(response);
      }
    };
    void load().catch(() => { if (current && isCurrentAuthEpoch(epoch)) setError(t('mcp.requestUnavailable')); })
      .finally(() => { if (current && isCurrentAuthEpoch(epoch)) setLoading(false); });
    return () => { current = false; };
  }, [authorization, request, id, reload, t]);
  const decide = async (approve: boolean) => {
    if (busy) return; const epoch = getAuthEpoch(); setBusy(true); setError('');
    try {
      if (authorization && request && consent) {
        const result = await mcpRequest<{ redirectUrl: string }>('POST', `/authorizations/${request}`, approve ? { approve, grant: form } : { approve });
        if (mounted.current && isCurrentAuthEpoch(epoch)) {
          const redirect = new URL(result.redirectUrl); const registered = new URL(consent.redirectUri);
          if (redirect.origin !== registered.origin || redirect.pathname !== registered.pathname) throw new Error('Unexpected callback.');
          window.location.assign(result.redirectUrl);
        }
      } else if (id) {
        await mcpRequest('POST', `/operations/${id}/decision`, { approve });
        if (mounted.current && isCurrentAuthEpoch(epoch)) { setReviewed(false); setReload(value => value + 1); }
      }
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.decisionError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
  const pending = operation?.state === 'pending' && (!operation.expiresAt || new Date(operation.expiresAt).getTime() > Date.now());
  return <main className="mcp-page"><section className="mcp-panel">
    <p><a href="/">Inboxora</a></p><h1>{authorization ? t('mcp.connectTitle') : t('mcp.reviewTitle')}</h1>
    <p>{t('mcp.signedInAs', { user: user?.email || user?.username || user?.displayName || '' })}</p>
    {loading && <p role="status">{t('mcp.loading')}</p>}{error && <p role="alert" className="mcp-error">{error}</p>}
    {!loading && error && <Button disabled={busy} onClick={() => setReload(value => value + 1)}>{t('mcp.refresh')}</Button>}
    {consent && <><div className="mcp-card"><h2>{consent.name}</h2><p className="mcp-warning">{t('mcp.unverifiedClient')}</p><p>{t('mcp.callback')} <code>{consent.redirectUri}</code></p></div>
      <McpGrantForm value={form} onChange={setForm} resources={resources} allowedScopes={consent.scopes} disabled={busy}/>
      <div className="mcp-actions"><Button disabled={busy} onClick={() => void decide(false)}>{t('mcp.deny')}</Button><Button variant="primary" disabled={busy || !form.name.trim() || !form.scopes.length || form.expiresInDays < 1 || form.expiresInDays > 365} onClick={() => void decide(true)}>{t('mcp.connect')}</Button></div></>}
    {operation && <><div className="mcp-card"><h2>{operation.integrationName}</h2><p><code>{operation.tool}</code> · {t(`mcp.states.${operation.state}`, { defaultValue: operation.state })}</p>
      {operation.expiresAt && <p>{t('mcp.expiresAt', { date: new Date(operation.expiresAt).toLocaleString() })}</p>}
      {operation.review && <><h3>{t('mcp.exactMessage')}</h3><pre className="mcp-code">{JSON.stringify(operation.review, null, 2)}</pre></>}
      <details open={!operation.review}><summary>{t('mcp.exactArguments')}</summary><pre className="mcp-code">{JSON.stringify(operation.arguments, null, 2)}</pre></details>
      {operation.result != null && <pre className="mcp-code">{JSON.stringify(operation.result, null, 2)}</pre>}
    </div>
      {pending ? <><p className="mcp-warning">{t('mcp.reviewWarning')}</p><label className="mcp-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} disabled={busy}/>{t('mcp.reviewed')}</label>
        <div className="mcp-actions"><Button disabled={busy} onClick={() => void decide(false)}>{t('mcp.deny')}</Button><Button variant="primary" disabled={busy || !reviewed} onClick={() => void decide(true)}>{t('mcp.approve')}</Button></div></>
        : <><p role="status">{operation.state === 'approved' ? t('mcp.returnToClient') : t('mcp.operationClosed')}</p><Button disabled={busy} onClick={() => setReload(value => value + 1)}>{t('mcp.refresh')}</Button></>}
    </>}
  </section></main>;
}
