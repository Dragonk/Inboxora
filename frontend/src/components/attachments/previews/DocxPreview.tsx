import { inertOfficeDom } from '../../../utils/attachments/inertOfficeDom.ts';
import { sanitizeSvg } from '../../../utils/attachments/image.ts';
import { imageDimensions } from '../../../utils/attachments/imageDimensions.ts';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { useTranslation } from 'react-i18next';
import { attachmentWork } from '../../../utils/attachments/workerClient.ts';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewStatus from '../PreviewStatus.tsx';
import { SafeAttachmentHtml } from './HtmlPreview.tsx';

/** Remove external relationships before any converter can create an image/font node. */
export function cleanOfficeXml(xml: string, relationships: boolean): string {
  if (xml.length > 2 * 1024 * 1024) throw new Error('LIMIT');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('CORRUPT');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('CORRUPT');
  for (const element of [...document.getElementsByTagName('*')]) {
    if (relationships && element.localName === 'Relationship') {
      const target = element.getAttribute('Target') || '';
      if (element.getAttribute('TargetMode')?.toLowerCase() === 'external' || /^[a-z][\w+.-]*:|^\/\//i.test(target)) element.remove();
    }
    // HTML altChunks, embedded objects and external linked images are not part of a passive preview.
    if (['altChunk', 'object', 'OLEObject', 'pict'].includes(element.localName)) element.remove();
    for (const attribute of [...element.attributes]) if (['src', 'href'].includes(attribute.localName) || attribute.localName.startsWith('on')) element.removeAttributeNode(attribute);
  }
  return new XMLSerializer().serializeToString(document);
}
async function safePackage(blob: Blob, signal: AbortSignal): Promise<Blob> {
  const entries = await attachmentWork('package', { blob }, signal);
  if (!entries.some(entry => entry.name === 'word/document.xml')) throw new Error('CORRUPT');
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, useCompressionStream: true, level: 0 });
  let xmlBytes = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    const xml = /\.(xml|rels)$/i.test(entry.name);
    if (xml) { xmlBytes += entry.blob.size; if (entry.blob.size > 2 * 1024 * 1024 || xmlBytes > 8 * 1024 * 1024) throw new Error('LIMIT'); }
    let value = xml ? new Blob([cleanOfficeXml(await entry.blob.text(), entry.name.endsWith('.rels'))]) : entry.blob;
    if (/\.svg$/i.test(entry.name)) {
      if (entry.blob.size > 2 * 1024 * 1024) throw new Error('LIMIT');
      value = new Blob([sanitizeSvg(await entry.blob.text())], { type: 'image/svg+xml' });
    } else if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(entry.name)) {
      if (!imageDimensions(new Uint8Array(await entry.blob.slice(0, 1024 * 1024).arrayBuffer()))) throw new Error('UNSUPPORTED');
    }
    await writer.add(entry.name, new BlobReader(value));
  }
  signal.throwIfAborted(); return writer.close();
}
export default function DocxPreview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation();
  const state = usePreviewResource(async signal => {
    const blob = await safePackage(file.blob, signal);
    const inert = inertOfficeDom();
    const container = inert.document.createElement('div');
    let fallback = false;
    try {
      const { renderAsync } = await import('docx-preview'); signal.throwIfAborted();
      await renderAsync(blob, container, container, { useBase64URL: true, renderAltChunks: false, ignoreFonts: true, ignoreWidth: true, ignoreHeight: true, experimental: false, h: inert.h });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message === 'LIMIT') throw error;
      fallback = true;
      const { convertToHtml } = await import('mammoth');
      const result = await convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
      signal.throwIfAborted(); return { html: result.value, fallback };
    }
    signal.throwIfAborted(); return { html: container.innerHTML, fallback };
  }, [file.blob]);
  if (!state.value) return <PreviewStatus loading={state.loading} error={state.error} />;
  return <section className="attachment-docx">{state.value.fallback && <p role="status">{t('attachment.preview.docxFallback')}</p>}<SafeAttachmentHtml html={state.value.html} /></section>;
}
