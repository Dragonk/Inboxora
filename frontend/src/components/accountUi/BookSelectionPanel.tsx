import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../../store/index.ts';
import { Button } from '../ui.tsx';
import { Icon, Popover, Notice } from './AccountUi.tsx';
import { ResourceTree } from './ResourceTree.tsx';
import { groupBooks, sourceLabel, type BookIdentity } from './model.ts';
import { openSettings } from './navigation.ts';

export interface BookSelectionPanelProps {
  books: readonly BookIdentity[]; selected: readonly string[]; onChange: (ids: string[]) => void;
  collapsed: readonly string[]; onCollapse: (id: string, collapsed: boolean) => void;
  open: boolean; onOpen: () => void; onClose: () => void; hideTrigger?: boolean;
  loading?: boolean; failed?: boolean;
}
export default function BookSelectionPanel(props: BookSelectionPanelProps) {
  const { t } = useTranslation(); const accounts = useStore(state => state.accounts);
  const trigger = useRef<HTMLButtonElement>(null);
  // Settings-hidden books stay discoverable in management, not silently selected here.
  const books = props.books.filter(book => book.visible !== false);
  const eligible = new Set(books.map(book => book.id)); const selected = props.selected.filter(id => eligible.has(id));
  const groups = groupBooks(books).map(group => ({ id: group.id, kind: group.kind,
    label: sourceLabel(group, t, accounts, true), identity: group.identityLabel, collapsed: props.collapsed.includes(group.id),
    resources: group.books.map(book => ({ id: book.id, name: book.name || t('accountUi.unnamed'), readOnly: book.read_only !== false, count: book.contact_count })) }));
  return <div className="au-book-selection">
    {!props.hideTrigger && <button ref={trigger} type="button" data-testid="contacts-books-trigger" className="au-picker-trigger" aria-expanded={props.open} aria-haspopup="dialog" onClick={props.onOpen}><Icon name="books"/><strong>{t('accountUi.displayedBooks')}</strong><small>{selected.length}/{books.length}</small><Icon name="down" size={12}/></button>}
    {props.open && <Popover title={t('accountUi.displayedBooks')} anchor={trigger.current} onClose={props.onClose} className="au-book-picker" footer={<><Button variant="ghost" onClick={() => { props.onClose(); openSettings({ module: 'contacts', section: 'accounts' }); }}><Icon name="settings"/>{t('accountUi.manageAccounts')}</Button><Button onClick={props.onClose}>{t('common.close')}</Button></>}>
      <div className="au-picker-controls"><button type="button" disabled={props.loading} onClick={() => props.onChange(books.map(book => book.id))}>{t('accountUi.showAll')}</button><span className="au-muted">{t('accountUi.selectedOf', { selected: selected.length, total: books.length })}</span><button type="button" disabled={props.loading} onClick={() => props.onChange([])}>{t('accountUi.clearAll')}</button></div>
      {props.failed && <Notice danger>{t('accountUi.preferencesFailed')}</Notice>}
      {props.loading ? <p className="au-note">{t('common.loading')}</p> : <ResourceTree groups={groups} selected={selected} onChange={props.onChange} onCollapse={props.onCollapse} onManage={(sourceId, resourceId) => { props.onClose(); openSettings({ module: 'contacts', section: resourceId || sourceId === 'local' ? 'resources' : 'accounts', sourceId, resourceId }); }}/>}
      {!props.loading && !books.length && <div className="au-empty">{t('accountUi.noResources')}</div>}
    </Popover>}
  </div>;
}
