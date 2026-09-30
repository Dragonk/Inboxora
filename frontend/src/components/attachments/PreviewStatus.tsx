import { useTranslation } from 'react-i18next';
export default function PreviewStatus({ loading = false, error }: { loading?: boolean; error?: string }) {
  const { t } = useTranslation();
  return <p className="attachment-status" role={loading ? 'status' : 'alert'}>{loading ? t('common.loading')
    : error === 'LIMIT' ? t('attachment.preview.limit') : error === 'ENCRYPTED_ZIP' ? t('attachment.preview.encryptedZip')
    : error === 'UNSUPPORTED' ? t('attachment.preview.unsupported') : error === 'RATE_LIMIT' ? t('attachment.preview.rateLimit')
    : t('attachment.preview.failed')}</p>;
}
