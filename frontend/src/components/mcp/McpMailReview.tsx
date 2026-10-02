import { useTranslation } from 'react-i18next';
import MessageBodyRenderer from '../MessageBodyRenderer.tsx';
import { MailRowAvatar, MailRowSender } from '../MailListPresentation.tsx';

type Review = Record<string, unknown>;

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function formatBytes(value: unknown): string {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function recipients(value: unknown, label: string) {
  const items = strings(value);
  if (!items.length) return null;
  return <div className="mcp-mail-recipient-row"><span>{label}</span><div>{items.map(address => <span key={address} className="mcp-mail-recipient">{address}</span>)}</div></div>;
}

export function isMailReview(review: Review | null | undefined): boolean {
  return review?.kind === 'mail' && typeof review.senderEmail === 'string';
}

export default function McpMailReview({ review }: { review: Review }) {
  const { t } = useTranslation();
  const senderEmail = text(review.senderEmail);
  const senderName = text(review.senderName) || senderEmail;
  const subject = text(review.subject);
  const bodyHtml = text(review.bodyHtml);
  const bodyText = text(review.bodyText);
  const signatureHtml = text(review.signatureHtml);
  const signatureText = text(review.signatureText);
  const signatureMode = text(review.signatureMode);
  const attachments = Array.isArray(review.attachments)
    ? review.attachments.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : [];

  const signatureLabel = signatureMode === 'override' ? t('mcp.signatureOverride')
    : signatureMode === 'none' ? t('mcp.signatureNone')
      : t('mcp.signatureConfigured');

  return <section className="mcp-mail-preview" aria-label={t('mcp.mailPreview')}>
    <div className="mcp-mail-preview-top">
      <MailRowAvatar email={senderEmail} name={senderName} />
      <div className="mcp-mail-sender">
        <MailRowSender unread style={{ display: 'block' }}>{senderName}</MailRowSender>
        <span>{senderEmail}</span>
      </div>
      {review.priority === 'high' && <span className="mcp-mail-priority">{t('mcp.priorityHigh')}</span>}
      {review.priority === 'low' && <span className="mcp-mail-priority">{t('mcp.priorityLow')}</span>}
    </div>

    <div className="mcp-mail-envelope">
      {recipients(review.to, t('compose.to'))}
      {recipients(review.cc, t('compose.cc'))}
      {recipients(review.bcc, t('compose.bcc'))}
    </div>

    <div className="mcp-mail-subject">{subject || t('message.noSubject')}</div>

    <div className="mcp-mail-body">
      <MessageBodyRenderer
        html={bodyHtml}
        text={bodyText}
        remoteImages={false}
        blockAllNetwork
        quoteFolding={false}
        title={t('message.emailFrameTitle')}
        style={{ width: '1px', minWidth: '100%', height: '180px', border: 0 }}
      />
      <div className="mcp-mail-signature-label">{signatureLabel}</div>
      {(signatureHtml || signatureText) ? <MessageBodyRenderer
        html={signatureHtml}
        text={signatureText}
        remoteImages={false}
        blockAllNetwork
        quoteFolding={false}
        title={t('admin.accounts.signatureSection')}
        style={{ width: '1px', minWidth: '100%', height: '100px', border: 0 }}
      /> : <div className="mcp-mail-empty-signature">{t('mcp.signatureEmpty')}</div>}
    </div>

    {attachments.length > 0 && <div className="mcp-mail-attachments">
      <div className="mcp-mail-section-label">{t('mcp.attachments')}</div>
      <div className="mcp-mail-attachment-list">
        {attachments.map((attachment, index) => {
          const filename = text(attachment.filename) || t('mcp.attachmentUnnamed');
          return <span className="mcp-mail-attachment" key={`${filename}-${index}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
            <span>{filename}</span><small>{formatBytes(attachment.bytes)}</small>
          </span>;
        })}
      </div>
    </div>}
  </section>;
}
