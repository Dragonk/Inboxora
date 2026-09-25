import { intlLocale } from '../../utils/intlLocale.ts';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Icon, IconButton, Popover, ProviderMark } from './AccountUi.tsx';
import { groupState, selectGroup } from './model.ts';

export interface TreeResource { id: string; name: string; readOnly: boolean; count?: number | null; color?: string | null }
export interface TreeGroup { id: string; kind: string; label: string; identity?: string | null; collapsed: boolean; resources: TreeResource[] }
export interface ResourceTreeProps {
  groups: readonly TreeGroup[]; selected: readonly string[];
  onChange: (ids: string[]) => void; onCollapse: (id: string, collapsed: boolean) => void;
  onManage: (groupId: string, resourceId?: string) => void;
  onColor?: (resource: TreeResource, groupId: string, anchor: HTMLElement) => void;
  disabled?: boolean;
}
export function ResourceTree({ groups, selected, onChange, onCollapse, onManage, onColor, disabled = false }: ResourceTreeProps) {
  const { t, i18n } = useTranslation();
  const locale = intlLocale(i18n.resolvedLanguage || i18n.language); const prefix = useId();
  const [menu, setMenu] = useState<{ group: TreeGroup; resource?: TreeResource; anchor: HTMLElement } | null>(null);
  const selection = new Set(selected);
  return <div className="au-tree">
    {groups.map((group, index) => {
      const ids = group.resources.map(resource => resource.id); const state = groupState(ids, selected); const bodyId = `${prefix}-${index}`;
      return <section data-testid={onColor ? "calendar-source-group" : "contacts-source-group"} className="au-source-group" key={group.id} data-source-id={group.id}>
        <header className="au-source-heading">
          <button type="button" className="au-collapse" data-testid={onColor ? "calendar-source-collapse" : "contacts-source-collapse"} aria-expanded={!group.collapsed} aria-controls={bodyId} aria-label={t(group.collapsed ? 'accountUi.expandGroup' : 'accountUi.collapseGroup', { name: group.label })} disabled={disabled} onClick={() => onCollapse(group.id, !group.collapsed)}><Icon name="chevron" size={13}/></button>
          <Check data-testid={onColor ? "calendar-group-visibility-toggle" : "contacts-group-visibility-toggle"} checked={state.checked} mixed={state.mixed} aria-label={t('accountUi.selectGroup', { name: group.label })} disabled={disabled || !state.total} onChange={() => onChange(selectGroup(selected, ids, !state.checked))}/>
          <button type="button" className="au-group-label" aria-expanded={!group.collapsed} aria-controls={bodyId} disabled={disabled} onClick={() => onCollapse(group.id, !group.collapsed)}><ProviderMark kind={group.kind}/><span><strong>{group.label}</strong>{group.identity && <small title={group.identity}>{group.identity}</small>}</span></button>
          <span className="au-group-count" aria-label={t('accountUi.selectedOf', { selected: state.count, total: state.total })}>{state.count}/{state.total}</span>
          <IconButton icon="more" label={t('accountUi.actionsFor', { name: group.label })} onClick={event => setMenu({ group, anchor: event.currentTarget })}/>
        </header>
        <div id={bodyId} hidden={group.collapsed}>{group.resources.map(resource => <div className="au-tree-row" data-resource-id={resource.id} data-selected={selection.has(resource.id)} key={resource.id}>
          <label><Check data-testid={onColor ? "calendar-visibility-toggle" : "contacts-book-visibility-toggle"} checked={selection.has(resource.id)} disabled={disabled} onChange={() => onChange(selectGroup(selected, [resource.id], !selection.has(resource.id)))}/><span title={resource.name}>{resource.name}</span></label>
          {onColor && <button type="button" data-testid="calendar-color-button" className="au-color-trigger" aria-label={t('accountUi.colorFor', { name: resource.name })} title={t('accountUi.colorFor', { name: resource.name })} onClick={event => onColor(resource, group.id, event.currentTarget)}><span className="au-color-dot" style={{ background: resource.color || 'var(--accent)' }}/></button>}
          {resource.readOnly && <span className="au-muted" title={t('accountUi.readOnly')} aria-label={t('accountUi.readOnly')}><Icon name="lock" size={11}/></span>}
          {typeof resource.count === 'number' && <span className="au-number">{new Intl.NumberFormat(locale).format(resource.count)}</span>}
          <IconButton icon="more" label={t('accountUi.actionsFor', { name: resource.name })} onClick={event => setMenu({ group, resource, anchor: event.currentTarget })}/>
        </div>)}</div>
      </section>;
    })}
    {menu && <Popover title={menu.resource?.name ?? menu.group.label} anchor={menu.anchor} onClose={() => setMenu(null)}><div className="au-menu">
      <button type="button" onClick={() => { onChange(menu.resource ? [menu.resource.id] : menu.group.resources.map(resource => resource.id)); setMenu(null); }}><Icon name="check"/>{t('accountUi.showOnly')}</button>
      {menu.resource && onColor && <button type="button" onClick={() => { onColor(menu.resource!, menu.group.id, menu.anchor); setMenu(null); }}><Icon name="calendar"/>{t('accountUi.eventColor')}</button>}
      <button type="button" onClick={() => { onManage(menu.group.id, menu.resource?.id); setMenu(null); }}><Icon name="settings"/>{t(menu.resource ? 'accountUi.resourceSettings' : 'accountUi.accountSettings')}</button>
    </div></Popover>}
  </div>;
}
