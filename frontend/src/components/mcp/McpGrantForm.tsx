import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { inputStyle } from '../ui.tsx';
import { Switch } from '../accountUi/AccountUi.tsx';
import { MCP_SCOPES, type McpGrantInput, type McpResources, type McpScope } from '../../utils/mcp.ts';
import './mcp.css';

interface Props { value: McpGrantInput; onChange: (value: McpGrantInput) => void; resources: McpResources; allowedScopes?: readonly McpScope[]; disabled?: boolean; }
export default function McpGrantForm({ value, onChange, resources, allowedScopes = MCP_SCOPES, disabled = false }: Props) {
  const { t } = useTranslation(); const prefix = useId();
  const selectIds = (key: 'accounts' | 'calendars' | 'addressBooks', items: { id: string; name: string }[]) => {
    const selected = value.restrictions[key];
    return <fieldset className="mcp-fieldset"><legend>{t(`mcp.${key}`)}</legend>
      <label className="mcp-check"><input type="checkbox" checked={selected === null} disabled={disabled}
        onChange={event => onChange({ ...value, restrictions: { ...value.restrictions, [key]: event.target.checked ? null : [], ...(key === 'accounts' ? { folders: null } : {}) } })}/>{t('mcp.allResources')}</label>
      {selected !== null && <select aria-label={t(`mcp.${key}`)} multiple size={Math.min(5, Math.max(2, items.length))} value={selected} style={inputStyle} disabled={disabled}
        onChange={event => onChange({ ...value, restrictions: { ...value.restrictions, [key]: Array.from(event.target.selectedOptions, option => option.value), ...(key === 'accounts' ? { folders: null } : {}) } })}>
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>}
      {selected?.length === 0 && <small>{t('mcp.noneSelected')}</small>}
    </fieldset>;
  };
  const folders = resources.folders.filter(folder => value.restrictions.accounts === null || value.restrictions.accounts.includes(folder.account_id));
  return <div className="mcp-form">
    <label htmlFor={`${prefix}-name`}>{t('mcp.name')}<input id={`${prefix}-name`} style={inputStyle} maxLength={120} value={value.name} disabled={disabled} autoComplete="off" onChange={event => onChange({ ...value, name: event.target.value })}/></label>
    <fieldset className="mcp-fieldset"><legend>{t('mcp.permissions')}</legend><div className="mcp-scope-grid">
      {allowedScopes.map(scope => <label key={scope} className="mcp-check"><input type="checkbox" checked={value.scopes.includes(scope)} disabled={disabled}
        onChange={event => onChange({ ...value, scopes: event.target.checked ? [...value.scopes, scope] : value.scopes.filter(item => item !== scope) })}/>
        <span>{t(`mcp.scopes.${scope.replace('.', '_')}`)}<small>{scope}</small></span></label>)}
    </div></fieldset>
    <div className="mcp-scope-grid">
      {selectIds('accounts', resources.accounts.map(account => ({ id: account.id, name: `${account.name} — ${account.email_address}` })))}
      {selectIds('calendars', resources.calendars)}
      {selectIds('addressBooks', resources.addressBooks)}
    </div>
    <fieldset className="mcp-fieldset"><legend>{t('mcp.folders')}</legend>
      <label className="mcp-check"><input type="checkbox" checked={value.restrictions.folders === null} disabled={disabled}
        onChange={event => onChange({ ...value, restrictions: { ...value.restrictions, folders: event.target.checked ? null : [] } })}/>{t('mcp.allFolders')}</label>
      {value.restrictions.folders !== null && <select aria-label={t('mcp.folders')} style={inputStyle} multiple size={5} disabled={disabled}
        value={folders.filter(folder => value.restrictions.folders?.some(item => item.accountId === folder.account_id && item.path === folder.path)).map(folder => folder.id)}
        onChange={event => { const ids = new Set(Array.from(event.target.selectedOptions, option => option.value)); onChange({ ...value, restrictions: { ...value.restrictions, folders: folders.filter(folder => ids.has(folder.id)).map(folder => ({ accountId: folder.account_id, path: folder.path })) } }); }}>
        {folders.map(folder => <option key={folder.id} value={folder.id}>{resources.accounts.find(account => account.id === folder.account_id)?.name} / {folder.path}</option>)}
      </select>}
      {value.restrictions.folders?.length === 0 && <small>{t('mcp.noneSelected')}</small>}
    </fieldset>
    <div className="mcp-confirm-setting"><span>{t('mcp.confirmWrites')}</span><Switch checked={value.requireConfirmation} disabled={disabled} onChange={checked => onChange({ ...value, requireConfirmation: checked })} label={t('mcp.confirmWrites')}/></div>
    {!value.requireConfirmation && <p role="alert" className="mcp-warning">{t('mcp.unattendedWarning')}</p>}
    <label htmlFor={`${prefix}-expiry`}>{t('mcp.expiresDays')}<input id={`${prefix}-expiry`} style={inputStyle} type="number" min={1} max={365} step={1} value={value.expiresInDays} disabled={disabled}
      onChange={event => onChange({ ...value, expiresInDays: Number(event.target.value) })}/></label>
  </div>;
}
