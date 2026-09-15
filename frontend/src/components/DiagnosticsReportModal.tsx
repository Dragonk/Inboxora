import { useBackLayer } from '../hooks/useBackNavigation.ts';
import { useState, useEffect, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.ts';
import { useUiScale } from '../hooks/useUiScale.ts';
import { generateReport } from '../utils/diagnostics.ts';
import type { StoreState } from '../store/index.ts';

// Sanitized diagnostics report: generate, preview (so the user can see exactly
// what will be shared), then download or copy. Nothing is sent automatically.
type DiagnosticsReport = Awaited<ReturnType<typeof generateReport>>;

type DiagnosticsReportModalProps = {
  onClose: () => void;
};

type DiagnosticsReportState =
  | { status: 'loading' }
  | { status: 'done'; json: DiagnosticsReport['json']; report: DiagnosticsReport['report'] }
  | { status: 'error'; error: string };

export default function DiagnosticsReportModal({ onClose }: DiagnosticsReportModalProps) {
  const { t, i18n } = useTranslation();
  const theme = useStore((s: StoreState) => s.theme);
  const uiScale = useUiScale();
  const addNotification = useStore((s: StoreState) => s.addNotification);
  const [state, setState] = useState<DiagnosticsReportState>({ status: 'loading' });
  useBackLayer(true, onClose, 5000);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    generateReport({ locale: i18n.language, theme, uiScale })
      .then(report => { if (!cancelled) setState({ status: 'done', ...report }); })
      .catch(error => { if (!cancelled) setState({ status: 'error', error: getErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [i18n.language, theme, uiScale]);

  const download = () => {
    if (state.status !== 'done') return;
    const blob = new Blob([state.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mailflow-diagnostics-${state.report.meta.reportId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    if (state.status !== 'done') return;
    try {
      await navigator.clipboard.writeText(state.json);
      addNotification({ title: t('diagnostics.copied') });
    } catch {
      addNotification({ type: 'error', title: t('diagnostics.copyFailed') });
    }
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 5000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div
        onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
        style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 12,
          width: 'min(640px, 100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{t('diagnostics.title')}</span>
          <button onClick={onClose} aria-label={t('common.cancel')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 18, lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ padding: '14px 16px', overflowY: 'auto' }}>
          {state.status === 'loading' && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>{t('diagnostics.generating')}</div>
          )}
          {state.status === 'error' && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--red, #ef4444)', fontSize: 13 }}>{t('diagnostics.error')}</div>
          )}
          {state.status === 'done' && (<>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>{t('diagnostics.blurb')}</p>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 8 }}>
              <div style={{ marginBottom: 4 }}>{t('diagnostics.includes')}</div>
              <div>{t('diagnostics.excludes')}</div>
            </div>
            <pre style={{
              margin: 0, padding: '10px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
              borderRadius: 8, fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-primary)',
              maxHeight: '38vh', overflow: 'auto', whiteSpace: 'pre', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}>{state.json}</pre>
          </>)}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={copy} disabled={state.status !== 'done'} style={btnStyle(false, state.status !== 'done')}>{t('common.copy')}</button>
          <button onClick={download} disabled={state.status !== 'done'} style={btnStyle(true, state.status !== 'done')}>{t('diagnostics.download')}</button>
        </div>
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string' && message) return message;
  }
  return 'error';
}

function btnStyle(primary: boolean, disabled: boolean) {
  return {
    padding: '7px 14px', borderRadius: 7, fontSize: 12.5, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text)' : 'var(--text-secondary)',
  };
}
