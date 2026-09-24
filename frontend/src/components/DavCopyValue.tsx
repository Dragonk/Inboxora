import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Keep long discovery URLs and one-time passwords readable without widening mobile settings. */
export default function DavCopyValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<'copied' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setFeedback(null);
    setBusy(false);
    return () => { generation.current += 1; };
  }, [value]);
  const copy = async () => {
    const current = generation.current;
    setBusy(true);
    setFeedback(null);
    try {
      await navigator.clipboard.writeText(value);
      if (current === generation.current) setFeedback('copied');
    } catch {
      if (current === generation.current) setFeedback('error');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return <div style={{ minWidth: 0, marginTop: 10 }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</span>
      <button type="button" disabled={busy} onClick={() => { void copy(); }} aria-label={`${t('common.copy')} — ${label}`}
        style={{ minHeight: 36, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: busy ? 'wait' : 'pointer' }}>
        {t('common.copy')}
      </button>
    </div>
    <code style={{ display: 'block', minWidth: 0, maxWidth: '100%', fontSize: 12, lineHeight: 1.6, whiteSpace: 'normal', overflowWrap: 'anywhere', userSelect: 'all' }}>{value}</code>
    {feedback && <div role={feedback === 'error' ? 'alert' : 'status'} style={{ fontSize: 12, marginTop: 4, color: feedback === 'error' ? 'var(--red)' : 'var(--green)' }}>
      {t(feedback === 'error' ? 'admin.davCredentials.copyError' : 'admin.davCredentials.copied')}
    </div>}
  </div>;
}
