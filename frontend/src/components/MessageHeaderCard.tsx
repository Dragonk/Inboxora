import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { MessageAvatar } from './MessagePresentation.tsx';
import './mailHeaderCard.css';

interface HeaderRecipient { name?: string | null; email?: string | null }
interface HeaderMessage {
  subject?: string | null; from_email?: string | null; from_name?: string | null;
  has_contact_photo?: boolean | null; account_color?: string | null;
  account_email?: string | null; account_name?: string | null; date?: string | number | Date | null;
}
/** Native reader sender card. Queue previews supply presentation data, never inbox actions. */
export default function MessageHeaderCard({ message, subject, isMobile = false, toList = [], ccList = [], body, date, recipientExtras }: {
  message: HeaderMessage; subject?: string | null; isMobile?: boolean;
  toList?: HeaderRecipient[]; ccList?: HeaderRecipient[];
  body?: { senderEmail?: string | null; senderName?: string | null } | null;
  date?: ReactNode; recipientExtras?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
        <div className="msg-card mail-header-card" data-message-header-card="true" style={{
          marginBottom: isMobile ? 12 : 24,
          marginLeft: isMobile ? 0 : undefined,
          marginRight: isMobile ? 0 : undefined,
          background: 'var(--bg-elevated)',
          borderRadius: isMobile ? 0 : 10,
          border: isMobile ? 'none' : '1px solid var(--border-subtle)',
          borderBottom: '1px solid var(--border-subtle)',
          borderLeft: message?.account_color ? `3px solid ${message.account_color}` : undefined,
          overflow: 'hidden',
          boxShadow: isMobile ? 'none' : 'var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}>
          {/* Subject */}
          <div style={{
            padding: '14px 16px 12px',
            borderBottom: '1px solid var(--border-subtle)',
            fontSize: 19, fontWeight: 600,
            color: 'var(--text-primary)', lineHeight: 1.3,
            fontFamily: 'var(--font-display)',
          }}>
            {(() => {
              const paneSubject = subject || message.subject;
              return (paneSubject && paneSubject !== '(no subject)')
                ? paneSubject
                : t('message.noSubject');
            })()}
          </div>

          <div className="mail-header-metadata" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}>
            {/* Avatar */}
            <MessageAvatar
              email={message.from_email}
              name={message.from_name}
              size={40}
              hasContactPhoto={message.has_contact_photo}
            />

            {/* Sender info */}
            <div className="mail-header-sender" data-message-header-sender="true" style={{ flex: 1, minWidth: 0 }}>
              {isMobile ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {message.from_name || message.from_email}
                  </div>
                  {message.from_name && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {message.from_email}
                    </div>
                  )}
                  {body?.senderEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>{t('message.via')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.senderName ? `${body.senderName} <${body.senderEmail}>` : body.senderEmail}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span>{t('message.to')} </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {toList.length > 0
                        ? toList.map((r: { name?: string | null; email?: string | null }, i: number) => (
                            <span key={i}>{r.name || r.email}{i < toList.length - 1 ? ', ' : ''}</span>
                          ))
                        : (message.account_email || message.account_name || '')}
                    </span>
                  </div>
                  {ccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span>{t('compose.cc')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {ccList.map((r: { name?: string | null; email?: string | null }, i: number) => (
                          <span key={i}>{r.name || r.email}{i < ccList.length - 1 ? ', ' : ''}</span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {message.from_name || message.from_email}
                    </span>
                    {message.from_name && (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        &lt;{message.from_email}&gt;
                      </span>
                    )}
                  </div>
                  {body?.senderEmail && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                      <span>{t('message.via')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>{body.senderName ? `${body.senderName} <${body.senderEmail}>` : body.senderEmail}</span>
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                    <span>{t('message.to')} </span>
                    <span style={{ color: 'var(--text-secondary)' }}>
                      {toList.length > 0
                        ? toList.map((r, i) => (
                            <span key={i}>
                              {r.name ? `${r.name} <${r.email}>` : r.email}
                              {i < toList.length - 1 ? ', ' : ''}
                            </span>
                          ))
                        : (message.account_email || message.account_name || '')}
                    </span>
                  </div>
                  {ccList.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                      <span>{t('compose.cc')} </span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {ccList.map((r, i) => (
                          <span key={i}>
                            {r.name ? `${r.name} <${r.email}>` : r.email}
                            {i < ccList.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              )}
              {recipientExtras}
            </div>

            {/* Date + account */}
            <div className="mail-header-date" data-message-header-date="true" style={{ flexShrink: 0, textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                {date ?? (message.date ? format(new Date(message.date), isMobile ? 'MMM d, h:mm a' : 'MMM d, yyyy h:mm a') : '')}
              </div>
              <div style={{
                fontSize: 11, marginTop: 4,
                display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
              }}>
                <div style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: message.account_color || 'var(--accent)',
                }} />
                <span style={{ color: 'var(--text-tertiary)' }}>{message.account_name}</span>
              </div>
            </div>
          </div>

        </div>
  );
}
