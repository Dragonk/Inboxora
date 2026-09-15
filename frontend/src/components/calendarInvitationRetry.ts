/** The event payload the invitation operation fingerprints and forwards. */
interface InvitationPayload { sendInvites?: boolean; [key: string]: unknown }
/** The calendar event API the operation drives. */
interface InvitationCalendarApi {
  createEvent: (payload: InvitationPayload, key?: string) => Promise<InvitationResult | null | undefined>;
  updateEvent?: (id: string | undefined, payload: InvitationPayload, key?: string) => Promise<InvitationResult | null | undefined>;
}
/** The save result fields the retry decision reads. */
interface InvitationResult {
  invitationError?: string | null;
  invitationStatus?: { status?: string; [key: string]: unknown } | null;
  [key: string]: unknown;
}

function payloadFingerprint(payload: InvitationPayload): string {
  return JSON.stringify(payload);
}

export function createInvitationOperationController({ randomUUID = () => globalThis.crypto.randomUUID() }: { randomUUID?: () => string } = {}) {
  let operation: { key: string; fingerprint: string } | null = null;

  return {
    async save(form: { mode: string; id?: string }, payload: InvitationPayload, calendarApi: InvitationCalendarApi) {
      if (!payload.sendInvites) operation = null;
      const fingerprint = payloadFingerprint(payload);
      if (payload.sendInvites && operation?.fingerprint !== fingerprint) {
        operation = { key: randomUUID(), fingerprint };
      }
      const key = operation?.key;
      let result: InvitationResult | null | undefined;
      if (form.mode === 'edit') {
        if (!calendarApi.updateEvent) throw new Error('calendar API has no updateEvent');
        result = await calendarApi.updateEvent(form.id, payload, key);
      } else {
        result = await calendarApi.createEvent(payload, key);
      }
      const retryable = Boolean(result?.invitationError)
        || Boolean(result?.invitationStatus && result.invitationStatus.status !== 'sent');
      if (!retryable) operation = null;
      return { result, retryable };
    },
    reset() {
      operation = null;
    },
    currentKey() {
      return operation?.key || null;
    },
  };
}
