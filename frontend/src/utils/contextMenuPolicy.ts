export function getContextMenuPolicy(variant = 'inbox') {
  const gtdSidebar = variant === 'gtdSidebar';
  return {
    select: !gtdSidebar,
    compose: true,
    archive: !gtdSidebar,
    snooze: !gtdSidebar,
    categorize: !gtdSidebar,
    done: gtdSidebar,
    rules: true,
    spam: !gtdSidebar,
    copy: true,
    viewHeaders: true,
  };
}

interface ContextMenuMessageReference {
  id: string;
  message_id?: string | null;
  account_id?: string;
}

export function resolveContextMenuMessage<Message extends ContextMenuMessageReference, Resolved>(
  message: Message,
  variant: string,
  resolveMessage: (ref: string, accountId: Message['account_id']) => Promise<Resolved>,
): Promise<Message | Resolved> {
  if (variant !== 'gtdSidebar') return Promise.resolve(message);
  return resolveMessage(message.message_id || message.id, message.account_id);
}
