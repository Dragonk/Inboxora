import { getAuthEpoch, isCurrentAuthEpoch } from '../../../utils/authEpoch.ts';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../utils/api.ts';
import { processAttachment, record, textValue } from '../../../utils/attachments/processing.ts';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
export default function IcsVcfPreview({ file, kind }: { file: PreviewFile; kind: 'ics' | 'vcf' }) {
  const epoch = useRef(getAuthEpoch());
  const current = () => alive.current && isCurrentAuthEpoch(epoch.current);
  const { t, i18n } = useTranslation(); const [selected, setSelected] = useState<Set<number>>(new Set()); const [collection, setCollection] = useState('');
  const [status, setStatus] = useState<'saving' | 'done' | 'failed' | null>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const state = usePreviewResource(async signal => {
    const parsed = record(await (await processAttachment(file.blob, 'cards', { kind }, signal)).json());
    const collections: unknown = kind === 'ics' ? await api.calendar.listCalendars({ signal }) : await api.addressBooks.list();
    signal.throwIfAborted();
    const list = record(collections); const entries = kind === 'ics' ? list.calendars : list.addressBooks;
    const writable = Array.isArray(entries) ? entries.map(record).filter(item => (item.source ?? 'local') === 'local' && !item.read_only).map(item => ({ id: textValue(item.id), name: textValue(item.name) })) : [];
    return { cards: Array.isArray(parsed.cards) ? parsed.cards.map(value => { const card = record(value); return {
      raw: textValue(card.raw), title: textValue(card.title), details: Array.isArray(card.details) ? card.details.map(textValue) : [], startsAt: textValue(card.startsAt), endsAt: textValue(card.endsAt),
    }; }) : [], collections: writable };
  }, [file.blob, kind]);
  const add = async () => {
    if (!current() || status === 'saving' || status === 'done' || !collection || !state.value || !selected.size) return; setStatus('saving');
    try {
      for (const index of selected) {
        if (!current()) return; const card = state.value.cards[index]; if (!card) continue;
        if (kind === 'ics') await api.calendar.importIcs(collection, card.raw); else await api.addressBooks.importVCard(collection, card.raw);
      }
      if (current()) { setStatus('done'); window.dispatchEvent(new Event(kind === 'ics' ? 'inboxora:calendar-changed' : 'inboxora:contacts-changed')); }
    } catch { if (current()) setStatus('failed'); }
  };
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  return <section className="attachment-cards"><div className="attachment-toolbar">
    <Button onClick={() => setSelected(new Set(state.value!.cards.map((_, index) => index)))}>{t('attachment.preview.selectAll')}</Button>
    <label>{t('attachment.preview.destination')}<select value={collection} onChange={event => setCollection(event.target.value)}>
      <option value="">{t('attachment.preview.chooseDestination')}</option>{state.value.collections.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>
    <Button disabled={!selected.size || !collection || status === 'saving' || status === 'done'} onClick={() => void add()}>{kind === 'ics' ? t('attachment.preview.addCalendar') : t('attachment.preview.addContacts')}</Button>
  </div>{!state.value.collections.length && <p>{t('attachment.preview.noDestination')}</p>}
    {status && <p role="status">{status === 'done' ? t('attachment.preview.imported') : status === 'saving' ? t('common.loading') : t('attachment.preview.importError')}</p>}
    {state.value.cards.map((card, index) => <article className="attachment-card" key={index}><label><input type="checkbox" checked={selected.has(index)} onChange={event => setSelected(value => { const next = new Set(value); if (event.target.checked) next.add(index); else next.delete(index); return next; })} />{card.title || t('common.noSubject')}</label>
      {card.startsAt && <p>{new Date(card.startsAt).toLocaleString(i18n.language)} – {new Date(card.endsAt).toLocaleString(i18n.language)}</p>}
      {card.details.map((detail, position) => <p key={position}>{detail}</p>)}
    </article>)}
  </section>;
}
