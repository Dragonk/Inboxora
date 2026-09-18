import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { spamApi } from '../utils/spamApi.ts';
import type { SpamStatus } from '../utils/spamApi.ts';

/** Per-user antispam status + master switch + decay window (data-testid hooks for tests). */
export default function SpamSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SpamStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    spamApi.status()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const next = await spamApi.setEnabled(!status.masterEnabled);
      setStatus({ ...status, masterEnabled: next.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-spam-settings="true" style={{ display: 'grid', gap: 8 }}>
      <h3>{t('spam.settingsTitle')}</h3>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <p role="status">{t('common.loading')}</p>}
      {status && (
        <>
          <p data-testid="spam-maturity">
            {t('spam.maturity', {
              level: status.maturity,
              // Maturity is gated on distinct USABLE samples (unique messages
              // per class), not on raw feedback rows: one mail confirmed 50x
              // is one sample. Showing trainingRecords here would claim a
              // readiness the classifier does not have. The raw event count
              // is appended for context.
              count: status.usableTrainingRecords ?? status.trainingRecords,
            })}
          </p>
          <p data-testid="spam-usable-detail" style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: 0 }}>
            {t('spam.maturityDetail', {
              spam: status.usableSpam ?? 0,
              ham: status.usableHam ?? 0,
              events: status.trainingRecords,
            })}
          </p>
          <button type="button" data-testid="spam-master-toggle" onClick={toggle} disabled={busy}>
            {status.masterEnabled ? t('spam.disable') : t('spam.enable')}
          </button>
          <button
            type="button"
            data-testid="spam-retrain-now"
            onClick={() => spamApi.retrainNow().catch(err => setError(err instanceof Error ? err.message : String(err)))}
          >
            {t('spam.retrainNow')}
          </button>
        </>
      )}
    </section>
  );
}
