/** Zero disables Undo Send; enabled delays are whole seconds through 60. */
export function validUndoSendSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 60;
}
