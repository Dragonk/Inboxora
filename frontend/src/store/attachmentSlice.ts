import type { StoreApi } from 'zustand';
import type { StoreState } from './index.ts';
import type { AttachmentSelection, AttachmentWindow } from '../utils/attachments/types.ts';
export interface AttachmentState {
  attachmentPreview: AttachmentSelection | null;
  attachmentWindows: AttachmentWindow[];
  openAttachmentPreview: (selection: AttachmentSelection) => void;
  closeAttachmentPreview: () => void;
  selectAttachmentPreview: (index: number) => void;
  selectAttachmentWindow: (id: string, index: number) => void;
  detachAttachmentPreview: () => void;
  closeAttachmentWindow: (id: string) => void;
  focusAttachmentWindow: (id: string) => void;
  minimizeAttachmentWindow: (id: string, minimized: boolean) => void;
  updateAttachmentWindowRect: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
}
/** Ephemeral descriptors only: blobs/passwords never enter the store or preferences. */
export function createAttachmentSlice(set: StoreApi<StoreState>['setState'], get: StoreApi<StoreState>['getState']): AttachmentState {
  return {
    attachmentPreview: null, attachmentWindows: [],
    openAttachmentPreview: selection => {
      if (selection.authEpoch === get().authEpoch && selection.attachments[selection.index]) set({ attachmentPreview: selection });
    },
    closeAttachmentPreview: () => set({ attachmentPreview: null }),
    selectAttachmentPreview: index => set(state => {
      const selection = state.attachmentPreview;
      return selection && selection.authEpoch === state.authEpoch && selection.attachments[index]
        ? { attachmentPreview: { ...selection, index } } : {};
    }),
    selectAttachmentWindow: (id, index) => set(state => ({ attachmentWindows: state.attachmentWindows.map(win =>
      win.id === id && win.selection.authEpoch === state.authEpoch && win.selection.attachments[index]
        ? { ...win, selection: { ...win.selection, index } } : win) })),
    detachAttachmentPreview: () => set(state => {
      const selection = state.attachmentPreview;
      if (!selection || selection.authEpoch !== state.authEpoch || state.attachmentWindows.length >= 4) return {};
      const existing = state.attachmentWindows.find(window => window.selection.attachments[window.selection.index]?.path === selection.attachments[selection.index]?.path);
      const seq = state._winSeq + 1;
      if (existing) return { attachmentPreview: null, _winSeq: seq, attachmentWindows: state.attachmentWindows.map(window => window.id === existing.id ? { ...window, minimized: false, z: seq } : window) };
      const w = Math.min(960, window.innerWidth - 48); const h = Math.min(780, window.innerHeight - 80);
      return { attachmentPreview: null, _winSeq: seq, attachmentWindows: [...state.attachmentWindows, {
        id: `aw-${seq}`, selection, x: Math.max(12, (window.innerWidth - w) / 2), y: 40, w, h, z: seq, minimized: false,
      }] };
    }),
    closeAttachmentWindow: id => set(state => ({ attachmentWindows: state.attachmentWindows.filter(window => window.id !== id) })),
    focusAttachmentWindow: id => set(state => ({ _winSeq: state._winSeq + 1, attachmentWindows: state.attachmentWindows.map(window => window.id === id ? { ...window, z: state._winSeq + 1 } : window) })),
    minimizeAttachmentWindow: (id, minimized) => set(state => ({ _winSeq: state._winSeq + 1, attachmentWindows: state.attachmentWindows.map(window => window.id === id ? { ...window, minimized, z: state._winSeq + 1 } : window) })),
    updateAttachmentWindowRect: (id, rect) => set(state => ({ attachmentWindows: state.attachmentWindows.map(window => window.id === id ? { ...window, ...rect } : window) })),
  };
}
