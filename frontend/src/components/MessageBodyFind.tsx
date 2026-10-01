import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { messageTextRanges } from '../utils/messageTextRanges.ts';
import { Button, Dialog, inputStyle } from './ui.tsx';
export default function MessageBodyFind({ frame, onClose }: { frame: RefObject<HTMLIFrameElement>; onClose: () => void }) {
  const { t } = useTranslation(); const [query, setQuery] = useState(''); const [matchCase, setMatchCase] = useState(false);
  const [current, setCurrent] = useState(-1); const [total, setTotal] = useState(0); const [error, setError] = useState(false);
  const move = (direction: number) => {
    const doc = frame.current?.contentDocument; if (!doc?.body) return;
    try {
      const ranges = messageTextRanges(doc.body, query, matchCase); setTotal(ranges.length); setError(false);
      if (!ranges.length) { setCurrent(-1); return; }
      const next = current < 0 ? direction < 0 ? ranges.length - 1 : 0 : (current + direction + ranges.length) % ranges.length;
      setCurrent(next); const range = ranges[next];
      const selection = doc.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
    } catch { setError(true); setTotal(0); }
  };
  return <Dialog title={t('message.find.title')} closeLabel={t('common.close')} onClose={onClose} testId="message-body-find"
    footer={<><Button disabled={!query} onClick={() => move(-1)}>{t('message.find.previous')}</Button><Button disabled={!query} onClick={() => move(1)}>{t('message.find.next')}</Button></>}>
    <label>{t('message.find.label')}<input autoFocus style={inputStyle} maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setCurrent(-1); setTotal(0); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); move(event.shiftKey ? -1 : 1); } }} /></label>
    <label><input type="checkbox" checked={matchCase} onChange={event => { setMatchCase(event.target.checked); setCurrent(-1); }} />{t('message.find.matchCase')}</label>
    <p role="status">{t('attachment.preview.matches', { current: total ? current + 1 : 0, total })}</p>
    {error && <p role="alert">{t('attachment.preview.limit')}</p>}
  </Dialog>;
}
