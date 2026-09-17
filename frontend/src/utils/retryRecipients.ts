export type RecipientRoles = {
  to: string[];
  cc: string[];
  bcc: string[];
};

/**
 * Return only SMTP-rejected recipients, retaining their original header roles and
 * display labels. SMTP commonly reports bare addresses while the compose fields
 * may contain display-name forms, so compare normalized mailbox addresses.
 */
export function partitionRejectedRecipients(
  rejected: readonly string[],
  recipients: RecipientRoles,
): RecipientRoles {
  const rejectedAddresses = new Set(rejected.map(normalizeMailbox));
  const keepRejected = (items: readonly string[]) =>
    items.filter(item => rejectedAddresses.has(normalizeMailbox(item)));

  return {
    to: keepRejected(recipients.to),
    cc: keepRejected(recipients.cc),
    bcc: keepRejected(recipients.bcc),
  };
}

function normalizeMailbox(recipient: string): string {
  const trimmed = recipient.trim();
  const angleAddress = trimmed.match(/<([^<>]+)>/)?.[1];
  return (angleAddress ?? trimmed).trim().toLowerCase();
}
