import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from './ui.tsx';
import { spamApi } from '../utils/spamApi.ts';
import type { SpamExplain } from '../utils/spamApi.ts';

interface SpamBadgeProps {
  messageId: string;
  verdict?: string | null;
  score?: number | null;
}

/** Compact verdict chip with a "Why?" dialog backed by GET /api/spam/explain. */
export default function SpamBadge({ messageId, verdict, score }: SpamBadgeProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState<SpamExplain | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (verdict !== 'spam' && verdict !== 'unsure') return null;

  const openExplain = async () => {
    setOpen(true);
    setError(null);
    try {
      setExplain(await spamApi.explain(messageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <button
        type="button"
        data-spam-badge={verdict}
        onClick={openExplain}
        style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', cursor: 'pointer' }}
      >
        {verdict === 'spam' ? t('spam.badgeSpam') : t('spam.badgeUnsure')}
        {typeof score === 'number' ? ` · ${Math.round(score * 100)}%` : ''}
      </button>
      {open && (
        <Dialog
          title={t('spam.explainTitle')}
          closeLabel={t('common.close')}
          onClose={() => setOpen(false)}
          testId="spam-explain-dialog"
          footer={<Button onClick={() => setOpen(false)}>{t('common.close')}</Button>}
        >
          {error ? <p role="alert">{error}</p> : !explain ? <p role="status">{t('common.loading')}</p> : (
            <div>
              <p>{t('spam.explainMethod', { method: explain.method })}</p>
              {explain.rulesFired.length > 0 && (
                <ul>
                  {explain.rulesFired.map(r => <li key={r.name}>{r.name} (+{r.weight})</li>)}
                </ul>
              )}
              {explain.mlTopTokens.length > 0 && (
                <ul>
                  {explain.mlTopTokens.map(tok => <li key={tok.token}>{tok.token} ({tok.contribution})</li>)}
                </ul>
              )}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
