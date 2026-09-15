// Conversation actions operate on one physical mailbox copy. A logical message
// remains visible while it still has another physical representation.
interface PhysicalCopy { id?: unknown }

interface LogicalMessage<Copy extends PhysicalCopy> {
  id?: unknown;
  copies?: Copy[];
}

export function removePhysicalCopy<Copy extends PhysicalCopy, Message extends LogicalMessage<Copy>>(
  logicalMessages: Message[] | null | undefined,
  logicalMessageId: unknown,
  copyId: unknown,
): Message[] {
  return (logicalMessages || [])
    .map(message => String(message.id) !== String(logicalMessageId)
      ? message
      : { ...message, copies: (message.copies || []).filter(copy => String(copy.id) !== String(copyId)) })
    .filter(message => message.copies?.length);
}
