/** Legacy omitted fields remain literal text, while only true opts into HTML parsing. */
export function resolveIncomingBodyIsHtml(bodyIsHtml: boolean | undefined): boolean {
  return bodyIsHtml === true;
}

/** Resolve the MIME representation without reinterpreting an explicit composition. */
export function resolveOutgoingBodyIsHtml(bodyIsHtml: boolean | undefined, preferredPlaintext: boolean): boolean {
  return bodyIsHtml ?? !preferredPlaintext;
}
