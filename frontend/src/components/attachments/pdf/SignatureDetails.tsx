import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewFile } from '../../../utils/attachments/types.ts';
import { processAttachment, record, textValue } from '../../../utils/attachments/processing.ts';
import { usePreviewResource } from '../usePreviewResource.ts';
import PreviewAction from '../PreviewAction.tsx';
import { Button, Dialog } from '../../ui.tsx';

type Verdict = 'valid' | 'invalid' | 'unknown';
interface SignatureRecord { status: Verdict; certificate: Record<string, string>; fields: Record<string, string> }
function verdict(value: unknown): Verdict { return value === 'valid' || value === 'invalid' ? value : 'unknown'; }
export function signatureReport(value: unknown) {
  const report = record(value);
  if (!Array.isArray(report.signatures) || report.signatures.length > 50) throw new Error('CORRUPT');
  const signatures: SignatureRecord[] = report.signatures.map(value => {
    const item = record(value); const certificate: Record<string, string> = {}; const fields: Record<string, string> = {};
    for (const key of ['commonName', 'givenName', 'surname', 'organization', 'country', 'email', 'subject', 'issuer', 'serial', 'validFrom', 'validTo', 'fingerprint']) {
      certificate[key] = item.certificate && typeof item.certificate === 'object' ? textValue(record(item.certificate)[key]).slice(0, 2048) : '';
    }
    for (const key of ['field', 'signer', 'claimedSigner', 'reason', 'location', 'contact', 'claimedTime', 'subFilter', 'integrity', 'trust', 'revocation', 'coverage', 'modification', 'diagnostic', 'digestAlgorithm', 'signatureAlgorithm', 'timestamp']) fields[key] = textValue(item[key]).slice(0, 2048);
    fields.page = typeof item.page === 'number' ? String(item.page) : '';
    fields.signedRevision = typeof item.signedRevision === 'number' ? String(item.signedRevision) : '';
    let status = verdict(item.status);
    if (status === 'valid' && (fields.integrity !== 'valid' || fields.trust !== 'valid' || fields.revocation !== 'checked')) status = 'unknown';
    return { status, certificate, fields };
  });
  const statuses = signatures.map(item => item.status);
  return { signatures, checkedAt: textValue(report.checkedAt), trustSource: textValue(report.trustSource), diagnostic: textValue(report.diagnostic),
    status: (statuses.includes('invalid') ? 'invalid' : statuses.length && statuses.every(value => value === 'valid') && report.status === 'valid' ? 'valid' : 'unknown') as Verdict };
}

export default function SignatureDetails({ file, count, metadata = [] }: { file: PreviewFile; count: number; metadata?: Array<{ name: string; date: string; reason: string }> }) {
  const { t, i18n } = useTranslation(); const [open, setOpen] = useState(false); const [selected, setSelected] = useState(0); const [retry, setRetry] = useState(0);
  const state = usePreviewResource(async signal => signatureReport(await (await processAttachment(file.blob, 'signatures', {}, signal)).json()), [file.blob, retry]);
  const report = state.value; const status = report?.status || 'unknown';
  const entries = report?.signatures.length ? report.signatures : Array.from({ length: Math.min(count, 50) }, (_, index) => ({ status: 'unknown' as const, fields: { signer: metadata[index]?.name || '', claimedTime: metadata[index]?.date || '', reason: metadata[index]?.reason || '' }, certificate: {} } as SignatureRecord));
  const active = Math.min(selected, Math.max(0, entries.length - 1)); const current = entries[active];
  const coverage = (value: string) => value === 'ENTIRE_FILE' ? t('attachment.signatures.fullDocument') : value === 'ENTIRE_REVISION' ? t('attachment.signatures.signedRevision') : t('attachment.signatures.unknown');
  const modification = (value: string) => value === 'NONE' ? t('attachment.signatures.unchanged') : value === 'LTA_UPDATES' ? t('attachment.signatures.validationUpdates') : value === 'FORM_FILLING' ? t('attachment.signatures.formUpdates') : value === 'OTHER' ? t('attachment.signatures.contentChanged') : t('attachment.signatures.unknown');
  const diagnostic = (value: string) => value === 'EMPTY_FIELD' ? t('attachment.signatures.empty') : value === 'CERTIFICATE_TIME' ? t('attachment.signatures.certTime') : value === 'VALIDATION_UNAVAILABLE' ? t('attachment.signatures.unavailable') : value ? t('attachment.signatures.trustUnavailable') : '';
  const label = (value: string) => value === 'valid' || value === 'checked' ? t('attachment.signatures.valid') : value === 'invalid' || value === 'revoked' ? t('attachment.signatures.invalid') : t('attachment.signatures.unknown');
  const date = (value: string) => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(i18n.language) : value; };
  const row = (key: string, title: string, value: string, timestamp = false) => <div className="attachment-signature-row" key={key}><dt>{title}</dt><dd>{value ? timestamp ? date(value) : value : t('attachment.signatures.notProvided')}</dd></div>;
  return <>
    <PreviewAction icon="signatures" label={t('attachment.signatures.title')} tooltip={state.loading ? t('attachment.signatures.checking') : `${t('attachment.signatures.title')}: ${label(status)}`}
      badge={<span className="attachment-status-dot" data-status={state.loading ? 'unknown' : status} aria-label={label(status)} />} onClick={() => setOpen(true)} />
    {open && <Dialog title={`${t('attachment.signatures.title')} — ${file.filename}`} closeLabel={t('common.close')} onClose={() => setOpen(false)} backPriority={4600} className="attachment-signature-dialog" testId="attachment-signature-dialog"
      footer={<><Button onClick={() => setRetry(value => value + 1)} disabled={state.loading}>{t('common.retry')}</Button><Button onClick={() => setOpen(false)}>{t('common.close')}</Button></>}>
      <p className="attachment-signature-policy">{t('attachment.signatures.policy')}</p>
      <p role="status">{state.loading ? t('attachment.signatures.checking') : state.error ? t('attachment.signatures.unavailable') : report?.diagnostic === 'ENCRYPTED_PDF' ? t('attachment.signatures.encrypted') : label(status)}</p>
      <div className="attachment-signature-layout"><nav aria-label={t('attachment.signatures.title')}>
        {entries.map((item, index) => <button key={index} type="button" aria-current={active === index} onClick={() => setSelected(index)}>
          <span className="attachment-status-dot" data-status={item.status} aria-label={label(item.status)} />{item.fields.signer || item.fields.field || t('attachment.signatures.number', { number: index + 1 })}
        </button>)}
      </nav><div className="attachment-signature-content">
        {current && <>
          <h3>{t('attachment.signatures.validation')}</h3><dl>
            {row('integrity', t('attachment.signatures.integrity'), label(current.fields.integrity))}
            {row('trust', t('attachment.signatures.trust'), label(current.fields.trust))}
            {row('revocation', t('attachment.signatures.revocation'), current.fields.revocation === 'checked' ? t('attachment.signatures.revocationChecked') : current.fields.revocation === 'revoked' ? t('attachment.signatures.revoked') : t('attachment.signatures.unknown'))}
            {row('timestamp', t('attachment.signatures.timestamp'), label(current.fields.timestamp))}
            {row('checked', t('attachment.signatures.checkedAt'), report?.checkedAt || '', true)}
          </dl>
          <h3>{t('attachment.signatures.signer')}</h3><dl>
            {row('name', t('attachment.signatures.signer'), current.fields.signer)}
            {row('claimedTime', t('attachment.signatures.claimedTime'), current.fields.claimedTime, true)}
            {row('email', t('attachment.signatures.email'), current.certificate.email || current.fields.contact)}
            {row('reason', t('attachment.signatures.reason'), current.fields.reason)}
            {row('location', t('attachment.signatures.location'), current.fields.location)}
          </dl>
          <h3>{t('attachment.signatures.certificate')}</h3><dl>
            {row('commonName', t('attachment.signatures.commonName'), current.certificate.commonName)}
            {row('givenName', t('attachment.signatures.givenName'), current.certificate.givenName)}
            {row('surname', t('attachment.signatures.surname'), current.certificate.surname)}
            {row('organization', t('attachment.signatures.organization'), current.certificate.organization)}
            {row('country', t('attachment.signatures.country'), current.certificate.country)}
            {row('issuer', t('attachment.signatures.issuer'), current.certificate.issuer)}
            {row('serial', t('attachment.signatures.serial'), current.certificate.serial)}
            {row('validFrom', t('attachment.signatures.validFrom'), current.certificate.validFrom, true)}
            {row('validTo', t('attachment.signatures.validTo'), current.certificate.validTo, true)}
            {row('fingerprint', t('attachment.signatures.fingerprint'), current.certificate.fingerprint)}
          </dl>
          <h3>{t('attachment.signatures.details')}</h3><dl>
            {row('field', t('attachment.signatures.field'), current.fields.field)}
            {row('page', t('attachment.preview.pageLabel'), current.fields.page)}
            {row('digestAlgorithm', t('attachment.signatures.digestAlgorithm'), current.fields.digestAlgorithm)}
            {row('signatureAlgorithm', t('attachment.signatures.signatureAlgorithm'), current.fields.signatureAlgorithm)}
            {row('subFilter', t('attachment.signatures.standard'), current.fields.subFilter)}
            {row('coverage', t('attachment.signatures.coverage'), coverage(current.fields.coverage))}
            {row('modification', t('attachment.signatures.modification'), modification(current.fields.modification))}
            {row('diagnostic', t('attachment.signatures.diagnostic'), diagnostic(current.fields.diagnostic))}
          </dl>
        </>}
        {report?.trustSource === 'system-tls' && <p>{t('attachment.signatures.trustNote')}</p>}
      </div></div>
    </Dialog>}
  </>;
}
