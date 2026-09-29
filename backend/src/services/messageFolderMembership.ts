/** Parameters describe an already-authorized mailbox scope; values remain bound by the caller. */
type MailboxScope = { accountIdParam: number } | { accountIdsParam: number } | { userIdParam: number };

function parameter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('Invalid mailbox query parameter');
  return `$${index}`;
}

/**
 * Match a physical folder or its Gmail labels through an uncorrelated membership
 * relation. Keeping the union outside an OR lets PostgreSQL use a semi-join that
 * can spill under memory pressure, rather than compile or repeatedly rescan a
 * label subplan per message. The union deduplicates physical copies, including when a
 * primary folder and multiple labels all identify the same view.
 * The account/message tuple preserves ownership even for malformed label rows.
 * Outer message alias: m. No folder parameter means the literal INBOX.
 */
export function messageFolderMembershipSql(scope: MailboxScope, folderParam?: number): string {
  const folder = folderParam === undefined ? "'INBOX'" : parameter(folderParam);
  const accounts = (alias: 'direct' | 'ml') => 'accountIdParam' in scope
    ? `${alias}.account_id = ${parameter(scope.accountIdParam)}`
    : 'accountIdsParam' in scope
      ? `${alias}.account_id = ANY(${parameter(scope.accountIdsParam)}::uuid[])`
      : `${alias}.account_id IN (SELECT id FROM email_accounts WHERE user_id = ${parameter(scope.userIdParam)} AND enabled = true)`;
  return `((m.account_id, m.id) IN (
    SELECT direct.account_id, direct.id FROM messages direct
    WHERE ${accounts('direct')} AND direct.folder = ${folder}
    UNION
    SELECT ml.account_id, ml.message_id FROM message_labels ml
    WHERE ${accounts('ml')} AND ml.folder_path = ${folder}
  ))`;
}
