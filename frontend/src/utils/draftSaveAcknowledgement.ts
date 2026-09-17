/** A captured revision is valid only when the field/document was not edited afterwards. */
export function isDraftSnapshotCurrent(snapshotRevision: number, currentRevision: number): boolean {
  return snapshotRevision === currentRevision;
}
