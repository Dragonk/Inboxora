import { z } from 'zod';
import { query } from '../services/db.js';
import { resolveAllDraftsPaths, resolveAllTrashPaths, resolveArchiveFolder, resolveSpamFolder, resolveTrashFolder, type FolderMappings } from '../utils/mailUtils.js';
import { domainRequest } from './bridge.js';
import { McpError, requireFolder, requireMessage, type Grant } from './policy.js';
import { id, writeTool } from './registry.js';

async function messageAccount(grant: Grant, messageId: string) {
  const message = await requireMessage(grant, messageId);
  const account = (await query<{ folder_mappings: FolderMappings | null; mail_transport: string }>('SELECT folder_mappings,mail_transport FROM email_accounts WHERE id=$1 AND user_id=$2', [message.account_id, grant.user_id])).rows[0];
  if (!account) throw new McpError('RESOURCE_UNAVAILABLE', 'Account not found.', 404);
  return { message, account };
}
export const mailActionTools = [
  ...([['set_email_read','read','read'], ['set_email_starred','star','starred']] as const).map(([name, path, field]) => writeTool(name,
    `Set one email's ${field} status. The returned provider status can be pending; pending is not confirmed.`, 'mail.modify', { messageId: id, value: z.boolean() },
    async (grant, args) => { await requireMessage(grant, args.messageId); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'PATCH', `/mail/messages/${args.messageId}/${path}`, { [field]: args.value }, operationId))),
  writeTool('move_email', 'Move one email to an existing permitted folder in the same account.', 'mail.modify', { messageId: id, destinationFolder: z.string().min(1).max(1024) },
    async (grant, args) => { const source = await requireMessage(grant, args.messageId); await requireFolder(grant, source.account_id, args.destinationFolder); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'POST', '/mail/messages/bulk-move', { ids: [args.messageId], folder: args.destinationFolder }, operationId)),
  writeTool('archive_email', 'Archive one email. Gmail removes its Inbox label; other providers use the archive folder. Archiving does not delete mail.', 'mail.modify', { messageId: id },
    async (grant, args) => {
      const { message, account } = await messageAccount(grant, args.messageId);
      if (account.mail_transport === 'gmail_api') return;
      const folder = await resolveArchiveFolder(message.account_id, account.folder_mappings);
      if (!folder) throw new McpError('ARCHIVE_UNAVAILABLE', 'No archive folder is configured.', 422);
      await requireFolder(grant, message.account_id, folder);
    }, async (grant, args, operationId) => {
      const result = await domainRequest(grant.user_id, 'POST', '/mail/messages/bulk-archive', { ids: [args.messageId] }, operationId);
      if (result.status < 400 && (!Array.isArray(result.body.archived) || !result.body.archived.includes(args.messageId))) {
        return { status: 502, body: { code: 'ARCHIVE_UNCONFIRMED', error: 'The provider has not confirmed this archive operation. Check Inboxora before retrying.' } };
      }
      return result;
    }),
  writeTool('delete_email', 'Move an email to Trash. Mail already in Trash and drafts are permanently deleted only with permanent=true. The flag must match the current operation; moving to Trash and permanent removal require separate approvals.', 'mail.delete',
    { messageId: id, permanent: z.boolean().default(false) }, async (grant, args) => {
      const { message, account } = await messageAccount(grant, args.messageId);
      const drafts = await resolveAllDraftsPaths(message.account_id, account.folder_mappings);
      const trash = await resolveAllTrashPaths(message.account_id, account.folder_mappings);
      const permanent = drafts.has(message.folder) || trash.has(message.folder);
      if (permanent !== args.permanent) throw new McpError('DELETE_MODE_MISMATCH', permanent ? 'This would permanently delete the message. Review it with permanent=true.' : 'Move the message to Trash first with permanent=false.', 409);
      if (!permanent) {
        const folder = await resolveTrashFolder(message.account_id, account.folder_mappings);
        if (!folder) throw new McpError('TRASH_UNAVAILABLE', 'No Trash folder is configured.', 422);
        await requireFolder(grant, message.account_id, folder);
      }
    }, (grant, args, operationId) => domainRequest(grant.user_id, 'DELETE', `/mail/messages/${args.messageId}`, undefined, operationId)),
  ...(['spam', 'ham'] as const).map(kind => writeTool(kind === 'spam' ? 'mark_email_spam' : 'mark_email_not_spam',
    kind === 'spam' ? 'Move an email to Spam and train the spam filter.' : 'Move an email to Inbox and mark it as not spam.', 'mail.spam', { messageId: id },
    async (grant, args) => {
      const { message, account } = await messageAccount(grant, args.messageId);
      const folder = kind === 'spam' ? await resolveSpamFolder(message.account_id, account.folder_mappings) : 'INBOX';
      if (!folder) throw new McpError('SPAM_FOLDER_UNAVAILABLE', 'No spam folder is configured.', 422);
      await requireFolder(grant, message.account_id, folder);
    }, (grant, args, operationId) => domainRequest(grant.user_id, 'POST', `/mail/messages/${args.messageId}/${kind}`, {}, operationId))),
  writeTool('unsubscribe_email', 'Use an email’s supported List-Unsubscribe mechanism. This may contact the sender or send an unsubscribe email; ask the user to approve it.', 'mail.unsubscribe', { messageId: id },
    async (grant, args) => { await requireMessage(grant, args.messageId); },
    (grant, args, operationId) => domainRequest(grant.user_id, 'POST', `/mail/messages/${args.messageId}/unsubscribe`, {}, operationId)),
];
