import { describe, bench } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';

describe('enqueueMailMerge arrays building', () => {
  const recipients = Array.from({ length: 100 }, (_, i) => `user${i}@example.com`);
  const batchId = randomUUID();
  const itemIds = recipients.map(() => randomUUID());

  // A typical frozen payload
  const frozen = {
    subject: 'Hello World',
    body: '<p>This is a test</p>',
    to: [],
    cc: [],
    bcc: [],
    forwardedAttachments: []
  };
  const first = { senderEmail: 'sender@example.com' };
  const fingerprint = 'xyz123abc456def789xyz123abc456def789';

  bench('baseline JSON.stringify', () => {
    const insertIds: string[] = [];
    const insertKeys: string[] = [];
    const insertFingerprints: string[] = [];
    const insertSubjects: string[] = [];
    const insertPayloads: string[] = [];

    for (const [index, recipient] of recipients.entries()) {
      const item = { senderEmail: first.senderEmail,
        payload: { ...frozen, to: [recipient] } };
      insertIds.push(itemIds[index]);
      insertKeys.push(`merge:${batchId}:${index}`);
      insertFingerprints.push(createHash('sha256').update(JSON.stringify({ fingerprint, recipient })).digest('hex'));
      insertSubjects.push(item.payload.subject ?? '');
      insertPayloads.push(JSON.stringify(item));
    }
    return { insertIds, insertKeys, insertFingerprints, insertSubjects, insertPayloads };
  });

  bench('optimized string manipulation', () => {
    const insertIds: string[] = [];
    const insertKeys: string[] = [];
    const insertFingerprints: string[] = [];
    const insertSubjects: string[] = [];
    const insertPayloads: string[] = [];

    const subject = frozen.subject ?? '';
    const fingerprintJsonPrefix = `{"fingerprint":${JSON.stringify(fingerprint)},"recipient":`;
    const baseItem = { senderEmail: first.senderEmail, payload: frozen };
    const itemJsonPrefix = JSON.stringify(baseItem).slice(0, -2);
    const hasPayloadKeys = Object.keys(frozen).length > 0;

    for (const [index, recipient] of recipients.entries()) {
      insertIds.push(itemIds[index]);
      insertKeys.push(`merge:${batchId}:${index}`);

      const recipientStr = JSON.stringify(recipient);
      const fStr = `${fingerprintJsonPrefix}${recipientStr}}`;
      insertFingerprints.push(createHash('sha256').update(fStr).digest('hex'));

      insertSubjects.push(subject);

      const payloadStr = hasPayloadKeys
        ? `${itemJsonPrefix},"to":[${recipientStr}]}}`
        : `${itemJsonPrefix}"to":[${recipientStr}]}}`;
      insertPayloads.push(payloadStr);
    }
    return { insertIds, insertKeys, insertFingerprints, insertSubjects, insertPayloads };
  });
});
