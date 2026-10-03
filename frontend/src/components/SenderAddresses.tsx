import { useId } from 'react';
import { useTranslation } from 'react-i18next';

export interface SenderAlias {
  id: string;
  name?: string | null;
  email?: string | null;
  reply_to?: string | null;
  signature?: string | null;
  default_cc?: string[] | null;
  default_bcc?: string[] | null;
}
interface Props {
  account: { id: string; email_address?: string | null; default_alias_id?: string | null; aliases?: SenderAlias[] };
  disabled?: boolean;
  onSelect: (aliasId: string | null) => void;
  onEdit: (alias: SenderAlias) => void;
  onDelete: (aliasId: string) => void;
}

/** The primary identity is structural, never a deletable alias row. */
export default function SenderAddresses({ account, disabled, onSelect, onEdit, onDelete }: Props) {
  const { t } = useTranslation();
  const group = useId();
  const aliases = account.aliases ?? [];
  const selected = aliases.some(alias => alias.id === account.default_alias_id && !!alias.email?.trim())
    ? account.default_alias_id : null;
  const rows: Array<{ id: string | null; email?: string | null; alias?: SenderAlias }> = [
    { id: null, email: account.email_address },
    ...aliases.map(alias => ({ id: alias.id, email: alias.email, alias })),
  ];
  return (
    <fieldset data-testid="sender-addresses" disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
        {t('admin.aliases.defaultSender')}
      </legend>
      {rows.map(row => (
        <div key={row.id ?? 'primary'} data-testid={row.id ? `sender-alias-${row.id}` : 'sender-primary'} style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
          padding: '12px 14px', marginBottom: 8, borderRadius: 10,
          border: `1px solid ${selected === row.id ? 'var(--accent)' : 'var(--border-subtle)'}`,
          background: 'var(--bg-tertiary)',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 12, flex: '1 1 180px', minWidth: 0, cursor: disabled ? 'wait' : 'pointer' }}>
            <input type="radio" name={group} checked={selected === row.id}
              onChange={() => onSelect(row.id)}
              aria-label={t('admin.aliases.useDefault', { email: row.email ?? '' })}
              style={{ accentColor: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{row.email}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                {row.alias ? row.alias.name : t('admin.aliases.primaryAddress')}
              </span>
              {!row.alias && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{t('admin.aliases.cannotRemove')}</span>}
              {row.alias?.reply_to && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{t('admin.aliases.replyToLabel')} {row.alias.reply_to}</span>}
              {selected === row.id && <span style={{ display: 'block', fontSize: 11, color: 'var(--accent)', marginTop: 3 }}>{t('admin.aliases.selectedDefault')}</span>}
            </span>
          </label>
          {row.alias && <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => { if (row.alias) onEdit(row.alias); }} aria-label={t('common.edit')}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: 7, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button type="button" onClick={() => { if (row.id) onDelete(row.id); }} aria-label={t('common.delete')}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, padding: 7, color: 'var(--red)', cursor: 'pointer' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </button>
          </div>}
        </div>
      ))}
    </fieldset>
  );
}
