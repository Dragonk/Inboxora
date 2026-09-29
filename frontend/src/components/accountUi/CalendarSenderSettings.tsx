import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { calendarSenders, calendarSenderValue } from '../../utils/calendarSenders.ts';
export default function CalendarSenderSettings() {
  const { t } = useTranslation();
  const accounts = useStore(state => state.accounts);
  const accountId = useStore(state => state.calendarInviteAccountId);
  const aliasId = useStore(state => state.calendarInviteAliasId);
  const setSender = useStore(state => state.setCalendarInviteSender);
  const senders = calendarSenders(accounts);
  return <label className="au-field" data-testid="calendar-sender-settings">
    {t('calendar.defaultInviteAccount')}
    <select data-testid="calendar-invite-account-setting" value={calendarSenderValue(accountId, aliasId)} onChange={event => {
      const sender = senders.find(item => item.value === event.target.value);
      setSender(sender?.accountId || '', sender?.aliasId || '');
    }}>
      <option value="">{t('calendar.defaultInviteAccountNone')}</option>
      {senders.map(sender => <option key={sender.value} value={sender.value}>{sender.label}</option>)}
    </select>
    <small>{t('calendar.defaultInviteAccountDescription')}</small>
  </label>;
}
