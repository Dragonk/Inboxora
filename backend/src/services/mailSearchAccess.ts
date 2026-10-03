/** Additional server-owned restrictions. Never constructed from an HTTP request body. */
export interface MailSearchAccess {
  accounts: string[] | null;
  folders: Array<{ accountId: string; path: string }> | null;
  allAccounts?: boolean;
}
function parameter(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('Invalid SQL parameter index');
  return `$${index}`;
}
const nativeGmail = "(a.mail_transport='gmail_api' AND NULLIF(m.provider_message_id,'') IS NOT NULL)";
/** Native Gmail membership is its labels, not the legacy INBOX storage coordinate of archived mail. */
export function searchFolderCondition(index: number, fuzzy = false, nestedIndex?: number): string {
  const value = parameter(index);
  if (fuzzy && nestedIndex === undefined) throw new Error('A fuzzy folder condition requires both parameters');
  const compare = (column: string) => fuzzy
    ? `(${column} ILIKE ${value} OR ${column} ILIKE ${parameter(nestedIndex!)})`
    : `${column} = ${value}`;
  return `((NOT COALESCE(${nativeGmail},false) AND ${compare('m.folder')}) OR
    (${nativeGmail} AND EXISTS(SELECT 1 FROM message_labels sfl WHERE sfl.message_id=m.id
      AND sfl.account_id=m.account_id AND ${compare('sfl.folder_path')})))`;
}
/** Outer aliases m and a are fixed. The JSON parameter contains exact account/folder pairs. */
export function searchFolderAccessCondition(index: number): string {
  const value = parameter(index);
  return `(${value}::jsonb IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(${value}::jsonb) af
    WHERE af->>'accountId'=m.account_id::text AND
      ((NOT COALESCE(${nativeGmail},false) AND m.folder=af->>'path') OR
       (${nativeGmail} AND EXISTS(SELECT 1 FROM message_labels sfa WHERE sfa.message_id=m.id
         AND sfa.account_id=m.account_id AND sfa.folder_path=af->>'path')))))`;
}
