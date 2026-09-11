import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from './ui.jsx';
import { conversationApi } from '../utils/conversationApi.js';
import { intlLocale } from '../utils/intlLocale.js';

// Rebuilding conversations re-runs threading over the messages already in the
// database. It matters most right after a migration from MailFlow, where every
// historical message predates the conversation engine and so has no conversation
// yet: the rebuild is what groups the backlog into threads.
//
// The action always goes through a confirmation dialog, and the dialog's dry-run
// option is checked by default. That makes the first click a report rather than a
// write, which is the difference between "let me see what this would do" and
// accidentally rewriting a mailbox's threading.

const POLL_INTERVAL_MS = 1000;
// The backend job map is in-process and dropped after an hour; stop polling well
// before that so a dialog left open cannot hammer the status endpoint forever.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const numberFormat = language => new Intl.NumberFormat(intlLocale(language));

function ResultSummary({ result, t, language }) {
  const format = numberFormat(language);
  const scanned = format.format(result?.scanned ?? 0);
  const changes = format.format(result?.would_change ?? result?.changed ?? 0);
  const dryRun = result?.dryRun !== false;
  const nothingToDo = (result?.would_change ?? result?.changed ?? 0) === 0;
  const key = nothingToDo
    ? 'conversation.rebuildNoChanges'
    : dryRun ? 'conversation.rebuildResultDry' : 'conversation.rebuildResultApplied';
  return <p className="settings-choice-description" data-testid="conversation-rebuild-result">
    {t(key, { scanned, changes })}
  </p>;
}

export default function ConversationRebuild() {
  const { t, i18n } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const timer = useRef(null);

  const stopPolling = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Poll until the job settles. The job runs in the backend process, so a page
  // reload simply loses the handle — the work itself is unaffected, which is why
  // an abandoned dialog is not treated as a failure.
  useEffect(() => {
    if (!jobId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await conversationApi.rebuildStatus(jobId);
        if (cancelled) return;
        setJob(status);
        if (status.status === 'complete' || status.status === 'failed') {
          if (status.status === 'failed') setError(t('conversation.rebuildFailed', { message: status.error || t('common.unknown') }));
          setJobId(null);
          return;
        }
      } catch (pollError) {
        if (cancelled) return;
        setError(pollError.message);
        setJobId(null);
        return;
      }
      timer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer.current = setTimeout(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; stopPolling(); };
  }, [jobId, stopPolling, t]);

  // The job map lives in process memory and expires after an hour, so a status
  // lookup can legitimately 404 after a restart or a long-running rebuild. When
  // polling gives up, say so instead of leaving the dialog looking stuck: the job
  // itself keeps running server-side and stays in the audit log.
  useEffect(() => {
    if (!jobId) return undefined;
    const expiry = setTimeout(() => {
      setJobId(null);
      setNote(t('conversation.rebuildContinuesInBackground'));
    }, POLL_TIMEOUT_MS);
    return () => clearTimeout(expiry);
  }, [jobId, t]);

  const close = () => {
    if (jobId) return; // A running job keeps the dialog open so its progress stays visible.
    setConfirming(false);
    setJob(null);
    setError('');
    setNote('');
  };

  const start = async () => {
    setError('');
    setNote('');
    setJob(null);
    try {
      const started = await conversationApi.rebuild({ dryRun });
      setJobId(started.jobId);
      setJob({ status: started.status || 'queued', result: null });
    } catch (startError) {
      // The endpoint allows two requests a minute per user, so a third call —
      // for example a retry straight after a failed one — is rate limited.
      setError(startError.status === 429
        ? t('conversation.rebuildRateLimited')
        : t('conversation.rebuildFailed', { message: startError.message }));
    }
  };

  const running = Boolean(jobId);

  return <div style={{ marginTop: 28, paddingTop: 22, borderTop: '1px solid var(--border-subtle)' }}>
    <div className="settings-switch-label">{t('conversation.rebuildConversations')}</div>
    <div className="settings-switch-description" style={{ marginBottom: 10 }}>
      {t('conversation.rebuildDescription')}
    </div>
    <Button
      variant="default"
      data-testid="conversation-rebuild-open"
      disabled={running}
      onClick={() => { setError(''); setJob(null); setConfirming(true); }}
    >
      {running ? t('conversation.rebuildRunning') : t('conversation.rebuildConversations')}
    </Button>

    {confirming && <Dialog
      title={t('conversation.rebuildConfirmTitle')}
      closeLabel={t('common.close')}
      onClose={close}
      testId="conversation-rebuild-dialog"
      busy={running}
      footer={<>
        <Button variant="default" data-testid="conversation-rebuild-cancel" disabled={running} onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" data-testid="conversation-rebuild-start" disabled={running} onClick={start}>
          {running ? t('conversation.rebuildRunning') : t('conversation.rebuildStart')}
        </Button>
      </>}
    >
      <p style={{ marginTop: 0 }}>{t('conversation.rebuildConfirmBody')}</p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 4 }}>
        <input
          type="checkbox"
          data-testid="conversation-rebuild-dry-run"
          checked={dryRun}
          disabled={running}
          onChange={event => setDryRun(event.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <span style={{ display: 'block', fontWeight: 600 }}>{t('conversation.rebuildDryRun')}</span>
          <span className="settings-switch-description">{t('conversation.rebuildDryRunHint')}</span>
        </span>
      </label>

      {job?.result && <ResultSummary result={job.result} t={t} language={i18n.language} />}
      {running && !job?.result && <p className="settings-choice-description">{t('conversation.rebuildRunning')}</p>}
      {note && <p className="settings-choice-description" data-testid="conversation-rebuild-note">{note}</p>}
      {error && <div role="alert" data-testid="conversation-rebuild-error" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</div>}
    </Dialog>}
  </div>;
}
