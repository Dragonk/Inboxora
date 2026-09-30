import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui.tsx';
export { findMatches } from '../../utils/attachments/find.ts';
const FindBar = forwardRef<HTMLInputElement, { query: string; setQuery: (value: string) => void; current: number; total: number; onNext: (direction: number) => void }>(function FindBar({ query, setQuery, current, total, onNext }, ref) {
  const { t } = useTranslation();
  return <div className="attachment-find" role="search">
    <input ref={ref} type="search" maxLength={200} aria-label={t('attachment.preview.find')} placeholder={t('attachment.preview.find')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onNext(event.shiftKey ? -1 : 1); } }} />
    <span role="status">{t('attachment.preview.matches', { current: total ? current + 1 : 0, total })}</span>
    <Button disabled={!total} aria-label={t('attachment.preview.previousMatch')} onClick={() => onNext(-1)}>↑</Button>
    <Button disabled={!total} aria-label={t('attachment.preview.nextMatch')} onClick={() => onNext(1)}>↓</Button>
  </div>;
});
export default FindBar;
