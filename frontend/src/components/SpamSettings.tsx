import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui.tsx';
import { Header, Notice, Switch } from './accountUi/AccountUi.tsx';
import { useAccountOperation } from './accountUi/useAccounts.ts';
import { useStore } from '../store/index.ts';
import { spamApi, type SpamStatus } from '../utils/spamApi.ts';

const maturityLabels = { mature: 'spam.maturityMature', fresh: 'spam.maturityFresh', insufficient: 'spam.maturityInsufficient' } as const;
/** Status, action and switches use the same theme-aware settings components. */
export default function SpamSettings() {
  const { t } = useTranslation(); const epoch = useStore(state => state.authEpoch);
  const [status, setStatus] = useState<SpamStatus | null>(null); const [error, setError] = useState(false);
  const operation = useAccountOperation();
  useEffect(() => {
    let active = true;
    const current = () => active && useStore.getState().authEpoch === epoch;
    setStatus(null); setError(false);
    void spamApi.status().then(value => { if (current()) setStatus(value); }).catch(() => { if (current()) setError(true); });
    return () => { active = false; };
  }, [epoch]);
  const toggle = () => void operation.run(async current => {
    if (!status) return; setError(false);
    try { const next = await spamApi.setEnabled(!status.masterEnabled);
      if (current()) setStatus(previous => previous && { ...previous, masterEnabled: next.enabled });
    } catch { if (current()) setError(true); }
  });
  const retrain = () => void operation.run(async current => {
    setError(false);
    try { await spamApi.retrainNow(); if (!current()) return;
      const next = await spamApi.status(); if (current()) setStatus(next);
    } catch { if (current()) setError(true); }
  });
  return <section className="au-workspace" data-spam-settings="true">
    <Header title={t('spam.settingsTitle')}/>
    {error && <Notice danger>{t('accountUi.operationFailed')}</Notice>}
    {!status && !error && <p role="status">{t('common.loading')}</p>}
    {status && <>
      <div className="au-switch-row"><div className="au-grow"><strong>{t('spam.settingsTitle')}</strong></div>
        <Switch label={t('spam.settingsTitle')} data-testid="spam-master-toggle" checked={status.masterEnabled} onChange={toggle} disabled={operation.busy}/>
      </div>
      <div className="au-section">
        <p data-testid="spam-maturity" className="au-note">{t('spam.maturity', {
          level: t(maturityLabels[status.maturity]),
          // Repeated feedback on one mail is not a new training sample.
          count: status.usableTrainingRecords ?? status.trainingRecords,
        })}</p>
        <p data-testid="spam-usable-detail" className="au-note">{t('spam.maturityDetail', {
          spam: status.usableSpam ?? 0, ham: status.usableHam ?? 0, events: status.trainingRecords,
        })}</p>
        <div className="au-actions"><Button data-testid="spam-retrain-now" disabled={operation.busy} onClick={retrain}>{t('spam.retrainNow')}</Button></div>
      </div>
    </>}
  </section>;

}
