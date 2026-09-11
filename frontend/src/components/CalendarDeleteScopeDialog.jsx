import { Button, Dialog } from './ui.jsx';

// Deleting one occurrence of a series is not the same operation as deleting the series, and the
// difference is not something a yes/no confirmation can express: the three answers produce three
// genuinely different calendars. Until now the interface only ever removed a single occurrence,
// so there was no way to remove a whole series, and no way to stop one from a given date onward.
//
// "This and every following occurrence" is sent to the server as a rule truncation, because a
// `RECURRENCE-ID;RANGE=THISANDFUTURE` exception carrying STATUS:CANCELLED was measured to leave
// the series completely unchanged.
export default function CalendarDeleteScopeDialog({ event, busy = false, onSelect, onClose, t }) {
  const when = event?.starts_at
    ? new Date(event.starts_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  return <Dialog
    title={t('calendar.deleteRecurringTitle')}
    closeLabel={t('calendar.close')}
    onClose={onClose}
    busy={busy}
    testId="calendar-delete-scope-dialog"
    footer={<Button disabled={busy} onClick={onClose}>{t('calendar.cancel')}</Button>}
  >
    <div className="ui-form">
      <p>{t('calendar.deleteRecurringBody')}</p>
      {when && <p className="calendar-delete-scope-when">{when}</p>}
      <div className="calendar-delete-scope-actions">
        <Button disabled={busy} data-testid="calendar-delete-scope-single" onClick={() => onSelect('single')}>{t('calendar.deleteScopeSingle')}</Button>
        <Button disabled={busy} data-testid="calendar-delete-scope-following" onClick={() => onSelect('following')}>{t('calendar.deleteScopeFollowing')}</Button>
        <Button variant="danger" disabled={busy} data-testid="calendar-delete-scope-all" onClick={() => onSelect('all')}>{t('calendar.deleteScopeAll')}</Button>
      </div>
    </div>
  </Dialog>;
}
