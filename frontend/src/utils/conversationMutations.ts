// Conversation actions operate on one physical mailbox copy. A logical message
// remains visible while it still has another physical representation.
export function removePhysicalCopy(logicalMessages, logicalMessageId, copyId) {
  return (logicalMessages || [])
    .map(message => String(message.id) !== String(logicalMessageId)
      ? message
      : { ...message, copies: (message.copies || []).filter(copy => String(copy.id) !== String(copyId)) })
    .filter(message => message.copies?.length);
}
