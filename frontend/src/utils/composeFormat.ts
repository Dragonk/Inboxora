/** A saved draft's representation must not be reinterpreted by profile settings. */
export function resolveComposeBodyIsHtml(persisted: boolean | undefined, preferredPlaintext: boolean): boolean {
  return persisted ?? !preferredPlaintext;
}

/** A persisted override, including an intentional empty value, is editable. */
export function shouldShowSignatureEditor(fromSignature: string | null | undefined, hasPersistedSignature: boolean): boolean {
  return fromSignature != null || hasPersistedSignature;
}

/** Preserve a visible plaintext edit even when the rich signature ref is empty. */
export function shouldIncludeSignatureOverride(signature: string, hasPersistedSignature: boolean, fromSignature: string | null | undefined): boolean {
  return hasPersistedSignature || signature !== '' || fromSignature != null;
}
