/** Resolve the MIME representation without reinterpreting an explicit composition. */
export function resolveOutgoingBodyIsHtml(bodyIsHtml: boolean | undefined, preferredPlaintext: boolean): boolean {
  return bodyIsHtml ?? !preferredPlaintext;
}
