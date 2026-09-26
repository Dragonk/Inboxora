/** Presence, not truthiness: an omitted Graph delta field is not an empty value. */
export function graphDeltaFields(message: object): string[] {
  return Object.keys(message).filter(key =>
    (message as Record<string, unknown>)[key] !== undefined,
  );
}

/** A flag-only update is not a newly delivered message. */
export function graphHasEnvelope(message: {
  internetMessageId?: string | null; subject?: string | null; bodyPreview?: string | null;
}): boolean {
  return Boolean(message.internetMessageId?.trim() || message.subject || message.bodyPreview);
}
