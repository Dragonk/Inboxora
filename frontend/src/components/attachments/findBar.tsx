import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import PreviewAction from './PreviewAction.tsx';
export { findMatches } from '../../utils/attachments/find.ts';
export interface FindBarHandle { focus: () => void }
const FindBar = forwardRef<FindBarHandle, { query: string; setQuery: (value: string) => void; current: number; total: number; onNext: (direction: number) => void }>(function FindBar({ query, setQuery, current, total, onNext }, ref) {
  const { t } = useTranslation(); const input = useRef<HTMLInputElement>(null); const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [expanded]);
  const focus = () => { setExpanded(true); requestAnimationFrame(() => input.current?.focus()); };
  useImperativeHandle(ref, () => ({ focus }));
  return <div ref={root} className="attachment-find" role="search" data-expanded={expanded}>
    <PreviewAction className="attachment-find-toggle" icon="search" label={t('attachment.preview.find')} aria-expanded={expanded} onClick={() => expanded ? setExpanded(false) : focus()} />
    <div className="attachment-find-fields">
      <input ref={input} type="search" maxLength={200} aria-label={t('attachment.preview.find')} placeholder={t('attachment.preview.find')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); onNext(event.shiftKey ? -1 : 1); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      }} />
      <span role="status">{t('attachment.preview.matches', { current: total ? current + 1 : 0, total })}</span>
      <PreviewAction icon="previous" disabled={!total} label={t('attachment.preview.previousMatch')} onClick={() => onNext(-1)} />
      <PreviewAction icon="next" disabled={!total} label={t('attachment.preview.nextMatch')} onClick={() => onNext(1)} />
    </div>
  </div>;
});
export default FindBar;
