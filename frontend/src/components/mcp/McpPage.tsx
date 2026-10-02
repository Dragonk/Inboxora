import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { getAuthEpoch, isCurrentAuthEpoch } from '../../utils/authEpoch.ts';
import { MCP_STATE_KEYS, clearMcpReturn, emptyResources, mcpRequest, newMcpGrant, returnFromMcpApproval, type McpConsent, type McpOperation, type McpResources } from '../../utils/mcp.ts';
import { Button } from '../ui.tsx';
import McpGrantForm from './McpGrantForm.tsx';
import McpMailReview, { isMailReview } from './McpMailReview.tsx';
import McpMailEditor, { type McpMailEdits } from './McpMailEditor.tsx';
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
  const [reload, setReload] = useState(0); const [closing, setClosing] = useState(false); const [editingMail, setEditingMail] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; clearMcpReturn(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true; const epoch = getAuthEpoch();
    setLoading(true); setError(''); setConsent(null); setOperation(null); setEditingMail(false);
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
  const saveMailEdit = async (edits: McpMailEdits) => {
    if (!id || busy) return; const epoch = getAuthEpoch(); setBusy(true); setError('');
    try {
      const result = await mcpRequest<{ id: string; review: Record<string, unknown> }>('POST', `/operations/${id}/edit`, edits);
      if (mounted.current && isCurrentAuthEpoch(epoch) && operation) {
        setOperation({ ...operation, review: result.review }); setEditingMail(false);
      }
    } catch { if (mounted.current && isCurrentAuthEpoch(epoch)) setError(t('mcp.editError')); }
    finally { if (mounted.current && isCurrentAuthEpoch(epoch)) setBusy(false); }
  };
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
        const receipt = await mcpRequest<{ operationId: string; state: string; result?: unknown; executionDeferred?: boolean }>('POST', `/operations/${id}/decision`, { approve });
        if (mounted.current && isCurrentAuthEpoch(epoch)) {
          if (operation) setOperation({ ...operation, state: receipt.state, result: receipt.result ?? operation.result });
          if ((approve && receipt.state === 'succeeded') || (!approve && receipt.state === 'denied')) {
            setClosing(true);
            window.setTimeout(returnFromMcpApproval, 120);
          } else setReload(value => value + 1);
        }
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
    {operation && <><div className="mcp-card"><h2>{operation.integrationName}</h2>
      <div className="mcp-operation-meta"><code>{operation.tool}</code><span>{t(MCP_STATE_KEYS[operation.state] ?? 'mcp.states.uncertain')}</span>
        {operation.expiresAt && <span>{t('mcp.expiresAt', { date: new Date(operation.expiresAt).toLocaleString() })}</span>}</div>
      {operation.review && isMailReview(operation.review) ? editingMail && pending
        ? <McpMailEditor operationId={id!} review={operation.review} busy={busy} onCancel={() => setEditingMail(false)} onSave={saveMailEdit}/>
        : <><McpMailReview operationId={id!} review={operation.review}/>{pending && <div className="mcp-actions"><Button disabled={busy} onClick={() => setEditingMail(true)}>{t('mcp.editMessage')}</Button></div>}</>
        : operation.review && <><h3>{t('mcp.exactMessage')}</h3><pre className="mcp-code">{JSON.stringify(operation.review, null, 2)}</pre></>}
      <details className="mcp-technical" open={!operation.review}><summary>{t('mcp.exactArguments')}</summary><pre className="mcp-code">{JSON.stringify(operation.arguments, null, 2)}</pre></details>
      {operation.result != null && <details className="mcp-technical"><summary>{t('mcp.operationResult')}</summary><pre className="mcp-code">{JSON.stringify(operation.result, null, 2)}</pre></details>}
    </div>
      {closing && <p role="status" className="mcp-success">{t('mcp.approvalSucceeded')}</p>}
      {pending && !editingMail ? <><p className="mcp-warning">{t('mcp.reviewWarning')}</p>
        <div className="mcp-actions"><Button disabled={busy} onClick={() => void decide(false)}>{t('mcp.deny')}</Button><Button variant="primary" disabled={busy} onClick={() => void decide(true)}>{busy ? t('mcp.executingApproval') : t('mcp.approve')}</Button></div></>
        : !pending && !closing && <><p role="status">{operation.state === 'approved' ? t('mcp.returnToClient') : t('mcp.operationClosed')}</p><Button disabled={busy} onClick={() => setReload(value => value + 1)}>{t('mcp.refresh')}</Button></>}
    </>}
  </section></main>;
}
