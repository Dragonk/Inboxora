import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FolderIcon from './FolderIcon.jsx';

const iconProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 };

function Icon({ name, filled = false }) {
  const p = { ...iconProps, fill: filled ? 'currentColor' : 'none' };
  switch (name) {
    case 'reply': return <svg {...p}><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>;
    case 'reply-all': return <svg {...p}><polyline points="7 17 2 12 7 7"/><polyline points="13 17 8 12 13 7"/><path d="M20 18v-2a4 4 0 00-4-4H2"/></svg>;
    case 'forward': return <svg {...p}><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 014-4h12"/></svg>;
    case 'archive': return <svg {...p}><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/><polyline points="9 13 12 16 15 13"/><line x1="12" y1="11" x2="12" y2="16"/></svg>;
    case 'move': return <svg {...p}><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>;
    case 'spam': return <svg {...p}><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>;
    case 'ham': return <svg {...p}><path d="M12 3L4 7v5c0 5 3.5 9.3 8 10.3C16.5 21.3 20 17 20 12V7L12 3z"/><polyline points="9 12 11 14 15 10"/></svg>;
    case 'read': return <svg {...p} strokeLinecap="round"><path d="M22,9v9c0,1.1-.9,2-2,2H4c-1.1,0-2-.9-2-2V9"/><polyline points="22 9 12 16 2 9"/><polyline points="22 9 12 2 22 9"/></svg>;
    case 'headers': return <svg {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
    case 'print': return <svg {...p}><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>;
    case 'ai': return <svg {...p} strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="M5 3v4M19 17v4M3 5h4M17 19h4"/></svg>;
    case 'star': return <svg {...p} fill={filled ? 'var(--amber)' : 'none'} stroke={filled ? 'var(--amber)' : 'currentColor'}><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
    case 'delete': return <svg {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>;
    case 'more': return <svg {...p} fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>;
    default: return null;
  }
}

export function ToolbarButton({ children, onClick, title, danger, style, action, targetId }) {
  const [hovered, setHovered] = useState(false);
  return <button type="button" onClick={onClick} title={title} data-message-action={action} data-action-target-id={targetId}
    className="btn-press" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{
      background: hovered ? (danger ? 'rgba(248,113,113,0.1)' : 'var(--bg-tertiary)') : 'transparent',
      border: `1px solid ${hovered ? (danger ? 'rgba(248,113,113,0.3)' : 'var(--border)') : 'transparent'}`,
      borderRadius: 6, padding: '6px 8px', color: danger ? (hovered ? 'var(--red)' : 'var(--text-tertiary)') : 'var(--text-secondary)',
      cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.1s', ...style,
    }}>{children}</button>;
}

function MenuItem({ icon, label, onClick, danger = false }) {
  return <button type="button" onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'transparent',
    border: 0, borderBottom: '1px solid var(--border-subtle)', color: danger ? 'var(--red)' : 'var(--text-primary)',
    cursor: 'pointer', fontSize: 13, textAlign: 'left',
  }} onMouseEnter={event => { event.currentTarget.style.background = 'var(--bg-hover)'; }} onMouseLeave={event => { event.currentTarget.style.background = 'transparent'; }}>
    <Icon name={icon}/><span>{label}</span>
  </button>;
}

export default function MessageToolbar({
  isMobile = false, defaultReplyAll = false, targetId, className, style,
  isRead = true, isStarred = false, currentFolder = null,
  folders = [], foldersLoading = false, onLoadFolders,
  onReply, onReplyAll, onForward, onArchive, onMove, onSpam, onHam,
  onSetRead, onViewHeaders, onPrint, aiActions = [], onAiAction, onManageAiActions, onStar, onDelete,
  shortcutLabel = () => null,
}) {
  const { t } = useTranslation();
  const [replyMenu, setReplyMenu] = useState(false);
  const [moveMenu, setMoveMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [search, setSearch] = useState('');
  const availableFolders = useMemo(() => folders.filter(folder => folder.path !== currentFolder && (!search.trim() || folder.name?.toLowerCase().includes(search.trim().toLowerCase()))), [currentFolder, folders, search]);
  const title = (key, shortcut) => isMobile ? t(key) : `${t(key)}${shortcutLabel(shortcut) ? ` (${shortcutLabel(shortcut)})` : ''}`;
  const stop = handler => event => { event.stopPropagation(); handler?.(); };
  const closeMore = handler => () => { setMoreMenu(false); handler?.(); };
  const openMove = event => { event.stopPropagation(); setMoveMenu(value => !value); if (!moveMenu) onLoadFolders?.(); };
  const menuStyle = { position: 'absolute', top: 'calc(100% + 4px)', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', zIndex: 200, boxShadow: 'var(--shadow-popover, 0 4px 20px rgba(0,0,0,.4))' };
  const primaryReply = defaultReplyAll ? onReplyAll : onReply;

  return <div className={className} data-testid="message-pane-toolbar" data-conversation-message-actions={targetId ? 'true' : undefined} data-action-target-id={targetId} style={{
    padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6,
    flexShrink: 0, flexWrap: 'wrap', minWidth: 0, overflow: 'visible', ...style,
  }} onClick={event => event.stopPropagation()}>
    <div style={{ position: 'relative', display: 'flex' }}>
      <ToolbarButton action={defaultReplyAll ? 'reply-all' : 'reply'} targetId={targetId} onClick={stop(primaryReply)} style={{ borderRadius: '6px 0 0 6px' }} title={title(defaultReplyAll ? 'message.replyAll' : 'message.reply', defaultReplyAll ? 'replyAll' : 'reply')}>
        <Icon name={defaultReplyAll ? 'reply-all' : 'reply'}/>
      </ToolbarButton>
      <ToolbarButton action="reply-options" targetId={targetId} onClick={event => { event.stopPropagation(); setReplyMenu(value => !value); }} style={{ borderRadius: '0 6px 6px 0', borderLeftColor: 'var(--border-subtle)' }} title={t('message.replyOptions')}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
      </ToolbarButton>
      {replyMenu && <><div onClick={event => { event.stopPropagation(); setReplyMenu(false); }} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 99 }}/><div style={{ ...menuStyle, left: 0, minWidth: 150 }}>
        <MenuItem icon={defaultReplyAll ? 'reply' : 'reply-all'} label={t(defaultReplyAll ? 'message.reply' : 'message.replyAll')} onClick={() => { setReplyMenu(false); (defaultReplyAll ? onReply : onReplyAll)?.(); }}/>
      </div></>}
    </div>
    <ToolbarButton action="forward" targetId={targetId} onClick={stop(onForward)} title={title('message.forward', 'forward')}><Icon name="forward"/></ToolbarButton>
    {onArchive && <ToolbarButton action="archive" targetId={targetId} onClick={stop(onArchive)} title={title('message.archive', 'archive')}><Icon name="archive"/></ToolbarButton>}
    {onMove && <div style={{ position: 'relative' }}>
      <ToolbarButton action="move" targetId={targetId} onClick={openMove} title={t('contextMenu.moveToFolder')}><Icon name="move"/></ToolbarButton>
      {moveMenu && <><div onClick={event => { event.stopPropagation(); setMoveMenu(false); }} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 199 }}/><div style={{ ...menuStyle, left: 0, minWidth: 220, maxWidth: 320 }}>
        <div style={{ padding: 8, borderBottom: '1px solid var(--border-subtle)' }}><input autoFocus={!isMobile} value={search} onChange={event => setSearch(event.target.value)} placeholder={t('contextMenu.folders.search')} style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)' }}/></div>
        <div style={{ maxHeight: isMobile ? '55vh' : 285, overflowY: 'auto' }}>
          {foldersLoading ? <div style={{ padding: 20, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('contextMenu.folders.loading')}</div> : availableFolders.length ? availableFolders.map(folder => <button type="button" key={folder.path} onClick={() => { setMoveMenu(false); onMove(folder.path); }} style={{ display: 'flex', gap: 8, width: '100%', padding: isMobile ? '12px 14px' : '8px 12px', background: 'none', border: 0, borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left' }}><span style={{ color: 'var(--text-tertiary)' }}><FolderIcon specialUse={folder.special_use}/></span><span>{folder.name}</span></button>) : <div style={{ padding: 20, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('contextMenu.folders.empty')}</div>}
        </div>
      </div></>}
    </div>}
    <div style={{ flex: 1 }}/>
    {isMobile ? <div style={{ position: 'relative' }}>
      <ToolbarButton action="more" targetId={targetId} onClick={event => { event.stopPropagation(); setMoreMenu(value => !value); }} title={t('message.more')}><Icon name="more"/></ToolbarButton>
      {moreMenu && <><div onClick={event => { event.stopPropagation(); setMoreMenu(false); }} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 99 }}/><div style={{ ...menuStyle, right: 0, minWidth: 200 }}>
        {onSetRead && <MenuItem icon="read" label={t(isRead ? 'contextMenu.markUnread' : 'contextMenu.markRead')} onClick={closeMore(() => onSetRead(!isRead))}/>}
        {onSpam && <MenuItem icon="spam" label={t('contextMenu.markAsSpam')} onClick={closeMore(onSpam)}/>}
        {onHam && <MenuItem icon="ham" label={t('contextMenu.markAsHam')} onClick={closeMore(onHam)}/>}
        {onViewHeaders && <MenuItem icon="headers" label={t('contextMenu.viewHeaders')} onClick={closeMore(onViewHeaders)}/>}
        {onPrint && <MenuItem icon="print" label={t('message.print')} onClick={closeMore(onPrint)}/>}
        {aiActions.map(action => <MenuItem key={action.id} icon="ai" label={action.label} onClick={closeMore(() => onAiAction?.(action))}/>)}
        {onManageAiActions && <MenuItem icon="ai" label={t('message.manageAiActions')} onClick={closeMore(onManageAiActions)}/>}
      </div></>}
    </div> : <>
      {onSpam && <ToolbarButton action="spam" targetId={targetId} onClick={stop(onSpam)} title={t('contextMenu.markAsSpam')}><Icon name="spam"/></ToolbarButton>}
      {onHam && <ToolbarButton action="ham" targetId={targetId} onClick={stop(onHam)} title={t('contextMenu.markAsHam')}><Icon name="ham"/></ToolbarButton>}
      {onSetRead && <ToolbarButton action={isRead ? 'unread' : 'read'} targetId={targetId} onClick={stop(() => onSetRead(!isRead))} title={t(isRead ? 'contextMenu.markUnread' : 'contextMenu.markRead')}><Icon name="read"/></ToolbarButton>}
      {onViewHeaders && <ToolbarButton action="headers" targetId={targetId} onClick={stop(onViewHeaders)} title={t('contextMenu.viewHeaders')}><Icon name="headers"/></ToolbarButton>}
      {onPrint && <ToolbarButton action="print" targetId={targetId} onClick={stop(onPrint)} title={title('message.print', 'printMessage')}><Icon name="print"/></ToolbarButton>}
      {aiActions.length > 0 && <div style={{ position: 'relative' }}><ToolbarButton action="ai" targetId={targetId} onClick={event => { event.stopPropagation(); setAiMenu(value => !value); }} title={t('message.aiActions')}><Icon name="ai"/><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg></ToolbarButton>
        {aiMenu && <><div onClick={event => { event.stopPropagation(); setAiMenu(false); }} aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 49 }}/><div style={{ ...menuStyle, right: 0, minWidth: 220 }}>{aiActions.map(action => <MenuItem key={action.id} icon="ai" label={action.label} onClick={() => { setAiMenu(false); onAiAction?.(action); }}/>) }{onManageAiActions && <MenuItem icon="ai" label={t('message.manageAiActions')} onClick={() => { setAiMenu(false); onManageAiActions(); }}/>}</div></>}
      </div>}
    </>}
    {onStar && <ToolbarButton action="star" targetId={targetId} onClick={stop(onStar)} title={t('message.star')}><Icon name="star" filled={isStarred}/></ToolbarButton>}
    {onDelete && <ToolbarButton action="delete" targetId={targetId} onClick={stop(onDelete)} title={t('message.delete')} danger><Icon name="delete"/></ToolbarButton>}
  </div>;
}
