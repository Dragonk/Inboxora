/** Never let preview keys delete/archive the message behind an overlay or floating window. */
export function stopPreviewKey(event: React.KeyboardEvent): void { event.stopPropagation(); }
export function editingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}
