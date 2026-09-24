import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '../ui.tsx';
import { Check, Notice } from './AccountUi.tsx';
export default function DeleteResourceDialog({ name, identity, remote = false, onClose, onConfirm, busy, failed }: { name: string; identity?: string; remote?: boolean; onClose: () => void; onConfirm: () => void; busy: boolean; failed?: boolean }) {
  const { t } = useTranslation(); const [confirm, setConfirm] = useState(''); const [ack, setAck] = useState(false);
  return <Dialog title={t('accountUi.deleteResource')} closeLabel={t('common.close')} busy={busy} onClose={onClose} footer={<><Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" disabled={busy || confirm !== name || !ack} onClick={onConfirm}>{t('common.delete')}</Button></>}>
    <div className="ui-form au-workspace"><strong>{name}</strong>{identity && <p className="au-note">{identity}</p>}<Notice danger>{t(remote ? 'accountUi.deleteRemoteWarning' : 'accountUi.deleteLocalWarning')}</Notice><label>{t('accountUi.confirmName')}<input value={confirm} disabled={busy} autoComplete="off" onChange={event => setConfirm(event.target.value)}/></label><label className="ui-check"><Check checked={ack} disabled={busy} onChange={event => setAck(event.target.checked)}/>{t('accountUi.confirmDelete')}</label>{failed && <Notice danger>{t('accountUi.operationFailed')}</Notice>}</div>
  </Dialog>;
}
