function payloadFingerprint(payload) {
  return JSON.stringify(payload);
}

export function createInvitationOperationController({ randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
  let operation = null;

  return {
    async save(form, payload, calendarApi) {
      if (!payload.sendInvites) operation = null;
      const fingerprint = payloadFingerprint(payload);
      if (payload.sendInvites && operation?.fingerprint !== fingerprint) {
        operation = { key: randomUUID(), fingerprint };
      }
      const key = operation?.key;
      const result = form.mode === 'edit'
        ? await calendarApi.updateEvent(form.id, payload, key)
        : await calendarApi.createEvent(payload, key);
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
