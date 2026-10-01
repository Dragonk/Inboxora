import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import PreviewAction from '../PreviewAction.tsx';

/** Keep typed percentages local until Enter or blur. */
export default function PdfZoom({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState(String(Math.round(value * 100)));
  useEffect(() => setInput(String(Math.round(value * 100))), [value]);
  const apply = (percent: number) => {
    const bounded = Math.max(50, Math.min(400, Math.round(percent)));
    setInput(String(bounded)); onChange(bounded / 100);
  };
  const commit = () => {
    if (input.trim() && Number.isFinite(Number(input))) apply(Number(input));
    else setInput(String(Math.round(value * 100)));
  };
  return <div className="attachment-zoom-control">
    <PreviewAction icon="zoomOut" label={t('attachment.preview.zoomOut')} disabled={value <= .5} onClick={() => apply(value * 100 - 25)} />
    <label className="attachment-zoom-value"><input type="number" inputMode="numeric" min={50} max={400} step="any"
      aria-label={t('attachment.preview.zoom')} value={input} onChange={event => setInput(event.target.value)} onBlur={commit} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.stopPropagation(); setInput(String(Math.round(value * 100))); }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); apply(value * 100 + (event.key === 'ArrowUp' ? 25 : -25)); }
      }} /><span aria-hidden="true">%</span></label>
    <PreviewAction icon="zoomIn" label={t('attachment.preview.zoomIn')} disabled={value >= 4} onClick={() => apply(value * 100 + 25)} />
  </div>;
}
