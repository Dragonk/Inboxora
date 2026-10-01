import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '../ui.tsx';
export default function AttachmentPasswordDialog({ onSubmit, onClose, incorrect = false, server = false, busy = false }: {
  onSubmit: (password: string) => void; onClose: () => void; incorrect?: boolean; server?: boolean; busy?: boolean;
}) {
  const { t } = useTranslation(); const [password, setPassword] = useState('');
  return <Dialog backPriority={4600} title={t('attachment.preview.passwordTitle')} closeLabel={t('common.close')} onClose={onClose} testId="attachment-password-dialog">
    <form onSubmit={event => { event.preventDefault(); if (!busy && password) { const value = password; setPassword(''); onSubmit(value); } }}>
      <p>{server ? t('attachment.preview.passwordServer') : t('attachment.preview.passwordLocal')}</p>
      <label>{t('attachment.preview.password')}<input type="password" autoFocus autoComplete="off" maxLength={256} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
      {incorrect && <p role="alert">{t('attachment.preview.wrongPassword')}</p>}
      <div className="attachment-toolbar"><Button onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!password || busy}>{busy ? t('common.loading') : t('attachment.preview.unlock')}</Button></div>
    </form>
  </Dialog>;
}
