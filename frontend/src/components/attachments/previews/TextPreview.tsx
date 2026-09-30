import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';
import AiMarkdown from '../../AiMarkdown.tsx';
import { Button } from '../../ui.tsx';
import FindBar, { findMatches } from '../findBar.tsx';
import PreviewStatus from '../PreviewStatus.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import { attachmentWork } from '../../../utils/attachments/workerClient.ts';
import { editingTarget } from '../shortcuts.ts';
import type { PreviewFile } from '../../../utils/attachments/types.ts';

export function DataTable({ rows }: { rows: string[][] }) {
  const { t } = useTranslation(); const [limit, setLimit] = useState(500);
  return <div className="attachment-table-scroll">
    <table className="attachment-table"><tbody>{rows.slice(0, limit).map((row, index) => <tr key={index}>{row.map((cell, column) => index === 0 ? <th scope="col" key={column}>{cell}</th> : <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
    {rows.length > limit && <Button onClick={() => setLimit(value => value + 500)}>{t('attachment.preview.moreRows', { count: rows.length - limit })}</Button>}
  </div>;
}
function HighlightedText({ text, language }: { text: string; language: string }) {
  const { value } = usePreviewResource(async signal => {
    if (text.length > 100000) return '';
    const { default: hljs } = await import('highlight.js/lib/common');
    if (!hljs.getLanguage(language)) return '';
    signal.throwIfAborted();
    return DOMPurify.sanitize(hljs.highlight(text, { language, ignoreIllegals: true }).value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] });
  }, [text, language]);
  return value ? <code dangerouslySetInnerHTML={{ __html: value }} /> : <code>{text}</code>;
}
export default function TextPreview({ file, kind }: { file: PreviewFile; kind: string }) {
  const { t } = useTranslation(); const [encoding, setEncoding] = useState(''); const [raw, setRaw] = useState(false);
  const [query, setQuery] = useState(''); const [current, setCurrent] = useState(0); const [copyStatus, setCopyStatus] = useState<'done' | 'failed' | null>(null);
  const section = useRef<HTMLElement>(null); const search = useRef<HTMLInputElement>(null); const content = useRef<HTMLPreElement>(null); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const state = usePreviewResource(signal => attachmentWork('text', { blob: file.blob, type: file.type, kind, encoding }, signal), [file.blob, file.type, kind, encoding]);
  useEffect(() => {
    const node = section.current;
    if (state.value && node?.closest('.attachment-surface') === document.activeElement) node.focus();
  }, [state.value]);
  const languages: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', yml: 'yaml', md: 'markdown', h: 'c', hpp: 'cpp', rs: 'rust', rb: 'ruby' };
  const ext = file.filename.split('.').at(-1)?.toLowerCase() || '';
  const syntax = kind === 'text' ? languages[ext] || ext : kind;
  const data = state.value; const text = data ? (raw || kind === 'markdown' ? data.raw : data.text) : '';
  const matches = useMemo(() => findMatches(text, query), [text, query]); const index = matches.length ? current % matches.length : 0;
  useEffect(() => { content.current?.querySelector('[data-current-match="true"]')?.scrollIntoView({ block: 'center' }); }, [index, query]);
  const parts = useMemo(() => {
    const result: React.ReactNode[] = []; let position = 0;
    matches.forEach((match, hit) => { result.push(text.slice(position, match.start)); result.push(<mark key={hit} data-current-match={hit === index}>{text.slice(match.start, match.end)}</mark>); position = match.end; });
    result.push(text.slice(position)); return result;
  }, [text, matches, index]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(data?.raw || ''); if (mounted.current) setCopyStatus('done'); }
    catch { if (mounted.current) setCopyStatus('failed'); }
  };
  if (!data) return <PreviewStatus loading={state.loading} error={state.error} />;
  return <section ref={section} tabIndex={-1} className="attachment-text" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
    else if (!editingTarget(event.target) && event.key === '/') { event.preventDefault(); search.current?.focus(); }
  }}>
    <div className="attachment-toolbar">
      {kind !== 'text' && <Button aria-pressed={raw} onClick={() => setRaw(value => !value)}>{raw ? t('attachment.preview.pretty') : t('attachment.preview.raw')}</Button>}
      <Button onClick={() => void copy()}>{t('attachment.preview.copy')}</Button>
      <label>{t('attachment.preview.encoding')}<select value={encoding} onChange={event => setEncoding(event.target.value)}>
        <option value="">{t('attachment.preview.autoEncoding', { encoding: data.encoding })}</option>
        {['utf-8', 'windows-1250', 'windows-1252', 'utf-16le', 'utf-16be'].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {copyStatus && <span role="status">{copyStatus === 'done' ? t('attachment.preview.copied') : t('attachment.preview.clipboardError')}</span>}
    </div>
    <FindBar ref={search} query={query} setQuery={value => { setQuery(value); setCurrent(0); }} current={index} total={matches.length} onNext={direction => setCurrent(value => (value + direction + matches.length) % Math.max(1, matches.length))} />
    {data.failed && <p role="status">{t('attachment.preview.rawFallback')}</p>}
    {data.limited && <p role="status">{t('attachment.preview.rowsLimited')}</p>}
    {query && kind === 'markdown' && <p>{t('attachment.preview.searchSource')}</p>}
    {!raw && !query && kind === 'markdown' ? <div className="attachment-markdown"><AiMarkdown markdown={data.raw} /></div>
      : !raw && !query && data.rows && !data.failed ? <DataTable rows={data.rows} />
      : <pre ref={content} className="attachment-code">{query ? <code>{parts}</code> : <HighlightedText text={text} language={syntax} />}</pre>}
  </section>;
}
