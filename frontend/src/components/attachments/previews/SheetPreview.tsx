import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { attachmentWork } from '../../../utils/attachments/workerClient.ts';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { Button } from '../../ui.tsx';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
import { DataTable } from './TextPreview.tsx';
export default function SheetPreview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation(); const [sheet, setSheet] = useState<string>();
  const state = usePreviewResource(signal => attachmentWork('sheet', { blob: file.blob, sheet }, signal), [file.blob, sheet]);
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  const { rows, names, limited, sheet: selected } = state.value;
  return <section className="attachment-sheet"><div className="attachment-toolbar" role="tablist" aria-label={t('attachment.preview.sheets')}>
    {names.map(name => <Button key={name} role="tab" aria-selected={name === selected} onClick={() => setSheet(name)}>{name}</Button>)}
  </div>{limited && <p role="status">{t('attachment.preview.rowsLimited')}</p>}<DataTable key={selected} rows={rows} /></section>;
}
