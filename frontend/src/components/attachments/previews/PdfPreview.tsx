import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, PasswordResponses, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { Button } from '../../ui.tsx';
import AttachmentPasswordDialog from '../AttachmentPasswordDialog.tsx';
import PreviewStatus from '../PreviewStatus.tsx';
import FindBar, { findMatches } from '../findBar.tsx';
import PdfPage from '../pdf/PdfPage.tsx';
import OutlinePanel, { outlineItems, type OutlineItem } from '../pdf/OutlinePanel.tsx';
import { editingTarget } from '../shortcuts.ts';
import { printImages } from '../print.ts';

GlobalWorkerOptions.workerSrc = workerUrl;
interface Signature { name: string; date: string; reason: string }
function metadata(value: object): Signature {
  const item = value as Record<string, unknown>;
  return { name: typeof item.signerName === 'string' ? item.signerName : '', date: typeof item.signingTime === 'string' ? item.signingTime : '', reason: typeof item.reason === 'string' ? item.reason : '' };
}
export default function PdfPreview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation(); const [pdf, setPdf] = useState<PDFDocumentProxy>(); const [error, setFailureCode] = useState<string>();
  const [base, setBase] = useState({ width: 612, height: 792 }); const [current, setCurrent] = useState(1); const [pageInput, setPageInput] = useState('1');
  const [zoom, setZoom] = useState(1); const [fit, setFit] = useState<'width' | 'page' | null>('width'); const [rotation, setRotation] = useState(0);
  const [outline, setOutline] = useState<OutlineItem[]>([]); const [panel, setPanel] = useState<'outline' | 'thumbs' | null>(null);
  const [signatures, setSignatures] = useState<Signature[]>([]); const [signatureFields, setSignatureFields] = useState(0);
  const [password, setPassword] = useState<{ submit: (value: string) => void; incorrect: boolean }>();
  const [query, setQuery] = useState(''); const [matches, setMatches] = useState<Array<{ page: number; snippet: string }>>([]); const [match, setMatch] = useState(0); const [searching, setSearching] = useState(false);
  const [printing, setPrinting] = useState(0); const [printError, setPrintError] = useState(false);
  const scroll = useRef<HTMLDivElement>(null); const searchInput = useRef<HTMLInputElement>(null);
  const task = useRef<PDFDocumentLoadingTask>(); const printController = useRef<AbortController>(); const alive = useRef(true);
  useEffect(() => {
    let active = true; alive.current = true;
    const controller = new AbortController();
    void file.blob.arrayBuffer().then(async buffer => {
      if (!active) return;
      const loading = getDocument({ data: new Uint8Array(buffer), enableXfa: false, useWasm: false,
        cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf-assets/standard_fonts/',
        maxImageSize: 24 * 1024 * 1024, canvasMaxAreaInBytes: 48 * 1024 * 1024,
      });
      task.current = loading;
      loading.onPassword = (update: (value: string) => void, reason: number) => { if (active) setPassword({ submit: value => { setPassword(undefined); update(value); }, incorrect: reason === PasswordResponses.INCORRECT_PASSWORD }); };
      const document = await loading.promise;
      if (!active) { await loading.destroy(); return; }
      if (document.numPages > 2000) { await loading.destroy(); throw new Error('LIMIT'); }
      const first = await document.getPage(1); const viewport = first.getViewport({ scale: 1 });
      if (!active) return;
      setBase({ width: viewport.width, height: viewport.height }); setPdf(document);
      const results = await Promise.allSettled([document.getOutline(), document.getSignatures(), document.getFieldObjects()]);
      if (!active) return;
      if (results[0].status === 'fulfilled') setOutline(outlineItems(results[0].value));
      if (results[1].status === 'fulfilled') setSignatures((results[1].value || []).map(metadata));
      if (results[2].status === 'fulfilled' && results[2].value) {
        let count = 0;
        for (const fields of results[2].value.values()) for (const field of fields) {
          const value = field as Record<string, unknown>; if (value.type === 'signature' || value.type === 'Sig' || value.fieldType === 'Sig') count++;
        }
        setSignatureFields(count);
      }
    }).catch((failure: unknown) => { if (active) setFailureCode(failure instanceof Error && failure.message === 'LIMIT' ? 'LIMIT' : 'CORRUPT'); });
    return () => { active = false; alive.current = false; controller.abort(); printController.current?.abort(); void task.current?.destroy(); };
  }, [file.blob]);
  useEffect(() => {
    const element = scroll.current; if (!element || !fit || !pdf) return;
    const resize = () => {
      const width = rotation % 180 ? base.height : base.width; const height = rotation % 180 ? base.width : base.height;
      const scale = fit === 'width' ? (element.clientWidth - 32) / width : Math.min((element.clientWidth - 32) / width, (element.clientHeight - 24) / height);
      setZoom(Math.max(.1, Math.min(4, scale)));
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize(); return () => observer.disconnect();
  }, [pdf, fit, base.width, base.height, rotation, panel]);
  useEffect(() => {
    const node = scroll.current;
    if (pdf && node?.closest('.attachment-surface') === document.activeElement) node.focus();
  }, [pdf]);
  const jump = useCallback((page: number) => {
    if (!pdf || !Number.isInteger(page)) return;
    const next = Math.max(1, Math.min(pdf.numPages, page));
    scroll.current?.querySelector(`[data-pdf-page="${next}"]`)?.scrollIntoView({ block: 'start' }); setCurrent(next); setPageInput(String(next));
  }, [pdf]);
  const updateCurrent = () => {
    const element = scroll.current; if (!element) return; const top = element.getBoundingClientRect().top;
    let nearest = 1; let distance = Infinity;
    for (const page of element.querySelectorAll<HTMLElement>('[data-pdf-page]')) {
      const rect = page.getBoundingClientRect();
      const delta = rect.top <= top + 20 && rect.bottom > top + 20 ? 0 : Math.abs(rect.top - top);
      if (delta < distance) { distance = delta; nearest = Number(page.dataset.pdfPage); }
    }
    if (element.scrollTop <= 1) nearest = 1;
    else if (element.scrollHeight - element.scrollTop - element.clientHeight <= 2) nearest = pdf?.numPages || nearest;
    setCurrent(nearest); if (document.activeElement?.getAttribute('data-pdf-page-input') !== 'true') setPageInput(String(nearest));
  };
  const scale = (amount: number) => { setFit(null); setZoom(value => Math.min(4, Math.max(.5, Math.round((value + amount) * 100) / 100))); };
  useEffect(() => {
    const element = scroll.current; if (!element) return;
    const wheel = (event: WheelEvent) => { if (event.ctrlKey) { event.preventDefault(); scale(event.deltaY < 0 ? .1 : -.1); } };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [pdf]);
  useEffect(() => {
    if (!pdf) return;
    let active = true; setMatches([]); setMatch(0);
    if (!query) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        const found: Array<{ page: number; snippet: string }> = []; let characters = 0;
        for (let number = 1; number <= pdf.numPages && active; number++) {
          const page = await pdf.getPage(number); if (!active) return;
          const content = await page.getTextContent(); if (!active) return;
          const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''); characters += text.length;
          if (characters > 20 * 1024 * 1024) throw new Error('LIMIT');
          for (const hit of findMatches(text, query)) {
            found.push({ page: number, snippet: text.slice(Math.max(0, hit.start - 35), Math.min(text.length, hit.end + 55)) });
            if (found.length >= 10000) break;
          }
          if (number % 10 === 0) { setMatches([...found]); await new Promise(resolve => setTimeout(resolve, 0)); }
          if (found.length >= 10000) break;
        }
        if (active) { setMatches(found); setSearching(false); if (found[0]) jump(found[0].page); }
      })().catch(() => { if (active) { setSearching(false); setFailureCode('LIMIT'); } });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [pdf, query, jump]);
  const nextMatch = (direction: number) => {
    if (!matches.length) return; const next = (match + direction + matches.length) % matches.length; setMatch(next); jump(matches[next].page);
  };
  const navigateOutline = async (destination: OutlineItem['dest']) => {
    if (!pdf || !destination) return;
    try {
      const dest: unknown = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
      if (!Array.isArray(dest) || !dest.length) return;
      const ref: unknown = dest[0]; let page: number;
      if (typeof ref === 'number') page = ref;
      else if (ref && typeof ref === 'object' && 'num' in ref && 'gen' in ref && typeof ref.num === 'number' && typeof ref.gen === 'number') page = await pdf.getPageIndex({ num: ref.num, gen: ref.gen });
      else return;
      if (alive.current) jump(page + 1);
    } catch { if (alive.current) setFailureCode('CORRUPT'); }
  };
  const print = async () => {
    if (!pdf || printing) return;
    const controller = new AbortController(); printController.current = controller; setPrinting(1); setPrintError(false);
    const canvas = document.createElement('canvas'); let render: RenderTask | undefined;
    const cancel = () => render?.cancel(); controller.signal.addEventListener('abort', cancel);
    try {
      if (pdf.numPages > 200) throw new Error('LIMIT');
      const images: Blob[] = []; let bytes = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        controller.signal.throwIfAborted(); const page = await pdf.getPage(number); controller.signal.throwIfAborted();
        const normal = page.getViewport({ scale: 1, rotation }); const ratio = Math.min(1.5, Math.sqrt(4 * 1024 * 1024 / (normal.width * normal.height)));
        const viewport = page.getViewport({ scale: ratio, rotation }); canvas.width = Math.max(1, Math.floor(viewport.width)); canvas.height = Math.max(1, Math.floor(viewport.height));
        render = page.render({ canvas, viewport, intent: 'print' }); await render.promise;
        const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('CORRUPT')), 'image/png'));
        bytes += image.size; if (bytes > 100 * 1024 * 1024) throw new Error('LIMIT'); images.push(image); canvas.width = 0; canvas.height = 0;
        if (alive.current) setPrinting(number);
      }
      await printImages(images, controller.signal);
    } catch { if (alive.current && !controller.signal.aborted) setPrintError(true); }
    finally { controller.signal.removeEventListener('abort', cancel); canvas.width = 0; canvas.height = 0; if (alive.current) setPrinting(0); }
  };
  if (!pdf) return <><PreviewStatus loading={!error} error={error} />{password && <AttachmentPasswordDialog incorrect={password.incorrect} onSubmit={password.submit} onClose={() => { setPassword(undefined); setFailureCode('UNSUPPORTED'); void task.current?.destroy(); }} />}</>;
  return <section className="attachment-pdf" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchInput.current?.focus(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') { event.preventDefault(); void print(); return; }
    if (editingTarget(event.target)) return;
    if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp', 'Home', 'End', '+', '=', '-', '0'].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowRight' || event.key === 'PageDown') jump(current + 1);
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') jump(current - 1);
    if (event.key === 'Home') jump(1); if (event.key === 'End') jump(pdf.numPages);
    if (event.key === '+' || event.key === '=') scale(.25); if (event.key === '-') scale(-.25); if (event.key === '0') setFit('width');
  }}>
    <div className="attachment-toolbar">
      <Button aria-label={t('attachment.preview.previousPage')} disabled={current === 1} onClick={() => jump(current - 1)}>‹</Button>
      <label className="attachment-page-label">{t('attachment.preview.pageLabel')}<input data-pdf-page-input="true" type="number" min={1} max={pdf.numPages} value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => jump(Number(pageInput))} onKeyDown={event => { if (event.key === 'Enter') jump(Number(pageInput)); }} /></label><span>/ {pdf.numPages}</span>
      <Button aria-label={t('attachment.preview.nextPage')} disabled={current === pdf.numPages} onClick={() => jump(current + 1)}>›</Button>
      <Button aria-label={t('attachment.preview.zoomOut')} onClick={() => scale(-.25)}>−</Button><select aria-label={t('attachment.preview.zoom')} value={zoom} onChange={event => { setFit(null); setZoom(Number(event.target.value)); }}>
        {![.5, .75, 1, 1.25, 1.5, 2, 3, 4].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        {[.5, .75, 1, 1.25, 1.5, 2, 3, 4].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
      </select><Button aria-label={t('attachment.preview.zoomIn')} onClick={() => scale(.25)}>+</Button>
      <Button onClick={() => setFit('width')}>{t('attachment.preview.fitWidth')}</Button><Button onClick={() => setFit('page')}>{t('attachment.preview.fitPage')}</Button>
      <Button aria-label={t('attachment.preview.rotateLeft')} onClick={() => setRotation(value => (value + 270) % 360)}>↶</Button>
      <Button onClick={() => setRotation(value => (value + 90) % 360)}>{t('attachment.preview.rotate')}</Button>
      {!!outline.length && <Button aria-pressed={panel === 'outline'} onClick={() => setPanel(value => value === 'outline' ? null : 'outline')}>{t('attachment.preview.outline')}</Button>}
      <Button aria-pressed={panel === 'thumbs'} onClick={() => setPanel(value => value === 'thumbs' ? null : 'thumbs')}>{t('attachment.preview.thumbnails')}</Button>
      <Button onClick={() => void print()} disabled={!!printing}>{t('attachment.preview.print')}</Button>
    </div>
    <FindBar ref={searchInput} query={query} setQuery={setQuery} current={match} total={matches.length} onNext={nextMatch} />
    {searching && <p role="status">{t('attachment.preview.searching')}</p>}
    {query && matches[match] && <p className="attachment-pdf-snippet">{matches[match].snippet}</p>}
    {(signatures.length > 0 || signatureFields > 0) && <details className="attachment-signatures"><summary>{t('attachment.preview.signatureFields', { count: Math.max(signatureFields, signatures.length) })}</summary>
      <p>{t('attachment.preview.signatureUnverified')}</p>{signatures.map((signature, index) => <p key={index}>{signature.name} · {signature.date} · {signature.reason}</p>)}</details>}
    {!!printing && <div role="status">{t('attachment.preview.printProgress', { page: printing, total: pdf.numPages })}<Button onClick={() => printController.current?.abort()}>{t('common.cancel')}</Button></div>}
    {printError && <PreviewStatus error="LIMIT" />}{error && <PreviewStatus error={error} />}
    <div className="attachment-pdf-layout">
      {panel && <aside className="attachment-pdf-sidebar" aria-label={panel === 'outline' ? t('attachment.preview.outline') : t('attachment.preview.thumbnails')}>
        {panel === 'outline' ? <OutlinePanel items={outline} navigate={destination => void navigateOutline(destination)} />
          : Array.from({ length: pdf.numPages }, (_, index) => <button className="attachment-pdf-thumb" aria-current={current === index + 1 ? 'page' : undefined} key={index} onClick={() => jump(index + 1)} aria-label={t('attachment.preview.page', { page: index + 1, total: pdf.numPages })}>
            <PdfPage document={pdf} number={index + 1} scale={120 / base.width} rotation={rotation} base={base} thumbnail /><span>{index + 1}</span>
          </button>)}
      </aside>}
      <div ref={scroll} tabIndex={-1} className="attachment-pdf-scroll" onScroll={updateCurrent}>
        {Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index} document={pdf} number={index + 1} scale={zoom} rotation={rotation} base={base} root={scroll} query={query} />)}
      </div>
    </div>
  </section>;
}
