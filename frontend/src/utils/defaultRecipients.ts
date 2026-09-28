export type RecipientField = 'to' | 'cc' | 'bcc';
export type Recipients = Record<RecipientField, string[]>;
export type PendingRecipients = Record<RecipientField, string>;
export interface AccountDefaults { id: string; default_cc?: string[]; default_bcc?: string[] }
const fields: RecipientField[] = ['to', 'cc', 'bcc'];

/** Match display-name chips without rewriting the user's authored representation. */
export function recipientKey(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}
/** Split settings input without hiding malformed mailboxes from server-side validation. */
export function splitDefaultRecipients(value: string): string[] {
  return value.split(/[,;]/).map(item => item.trim()).filter(Boolean);
}
/** Include unfinished recipient inputs in duplicate detection without splitting quoted names. */
function pendingKeys(pending: PendingRecipients): string[] {
  return fields.flatMap(field => pending[field].split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(recipientKey));
}

/** Compose-local ownership, never persisted: restored draft recipients are manual. */
export class DefaultRecipients {
  private accountId: string;
  private mayAddDefaults: boolean;
  private retryOnly = false;
  private account: AccountDefaults | undefined;
  private automatic: Recipients = { to: [], cc: [], bcc: [] };
  private replyCc: string[];
  private dismissed = new Set<string>();
  /** Seed a new composer once; saved draft recipients are explicit and never seeded again. */
  constructor(account: AccountDefaults | undefined, recipients: Recipients, persisted = false, replyAll = false) {
    this.accountId = account?.id ?? '';
    this.mayAddDefaults = !persisted;
    this.account = account;
    this.replyCc = replyAll && !persisted ? [...recipients.cc] : [];
    if (!persisted) this.add(account, recipients, { to: '', cc: '', bcc: '' });
  }
  /** Append unoccupied account defaults, preferring blind copies over automatic CC matches. */
  private add(account: AccountDefaults | undefined, recipients: Recipients, pending: PendingRecipients) {
    const occupied = new Set([...fields.flatMap(field => recipients[field].map(recipientKey)), ...pendingKeys(pending)]);
    // BCC wins only between automatic defaults. Authored recipients stay untouched.
    for (const field of ['bcc', 'cc'] as const) {
      for (const value of account?.[field === 'bcc' ? 'default_bcc' : 'default_cc'] ?? []) {
        const key = recipientKey(value);
        if (!key || occupied.has(key) || this.dismissed.has(key)) continue;
        recipients[field].push(value);
        this.automatic[field].push(value);
        occupied.add(key);
      }
    }
  }
  /** Relinquish automatic ownership as soon as a chip is removed or edited. */
  edit(field: RecipientField, next: string[]) {
    // Removing/editing a chip relinquishes ownership immediately, even if re-added later.
    for (const value of this.automatic[field]) if (!next.includes(value)) this.dismissed.add(recipientKey(value));
    this.automatic[field] = this.automatic[field].filter(value => next.includes(value));
    if (field === 'cc') {
      for (const value of this.replyCc) if (!next.includes(value)) this.dismissed.add(recipientKey(value));
      this.replyCc = this.replyCc.filter(value => next.includes(value));
    }
  }
  /** Manual additions displace matching automatic chips, never another manual recipient. */
  editRecipients(field: RecipientField, values: string[], current: Recipients): Recipients {
    const remaining = [...current[field]];
    const added = values.filter(value => {
      const index = remaining.indexOf(value);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    const manualKeys = new Set(added.map(recipientKey));
    this.edit(field, values);
    return this.displaceAutomatic(manualKeys, { ...current, [field]: values });
  }
  /** Reconcile raw input too: keyboard Send/Save does not necessarily blur the field. */
  editPending(field: RecipientField, value: string, current: Recipients): Recipients {
    const pending = { to: '', cc: '', bcc: '', [field]: value };
    return this.displaceAutomatic(new Set(pendingKeys(pending)), { ...current });
  }
  /** Remove only owned duplicate occurrences, retaining the newly authored recipient. */
  private displaceAutomatic(manualKeys: Set<string>, next: Recipients): Recipients {
    for (const role of fields) {
      const displaced = this.automatic[role].filter(value => manualKeys.has(recipientKey(value)));
      if (!displaced.length) continue;
      // Remove exactly the owned occurrence; an identical newly typed chip is manual.
      next[role] = [...next[role]];
      for (const value of displaced) {
        const index = next[role].indexOf(value);
        if (index >= 0) next[role].splice(index, 1);
        this.dismissed.add(recipientKey(value));
      }
      this.automatic[role] = this.automatic[role].filter(value => !displaced.includes(value));
    }
    return next;
  }
  /**
   * Convert confirmed partial-delivery recovery into explicit recipient editing.
   * Neither sender changes nor Reply All may alter retry targets automatically.
   * This applies only to the retained composer; unknown send outcomes are untouched.
   */
  enterRetryMode(): void {
    this.retryOnly = true;
    this.mayAddDefaults = false;
    this.automatic = { to: [], cc: [], bcc: [] };
    this.replyCc = [];
  }
  /** Replace untouched account defaults, except during explicit partial-delivery recovery. */
  switchAccount(account: AccountDefaults | undefined, current: Recipients, pending: PendingRecipients): Recipients {
    if (!account || account.id === this.accountId || this.retryOnly) return current;
    const next = { ...current };
    for (const field of fields) next[field] = current[field].filter(value => !this.automatic[field].includes(value));
    this.automatic = { to: [], cc: [], bcc: [] };
    this.accountId = account.id;
    this.mayAddDefaults = true;
    this.account = account;
    this.dismissed.clear();
    this.add(account, next, pending);
    return next;
  }
  /** Reconcile implicit reply recipients without overriding edits or confirmed retry targets. */
  switchReply(all: boolean, candidates: string[], current: Recipients, pending: PendingRecipients): Recipients {
    if (this.retryOnly) return current;
    const next = { to: [...current.to], cc: current.cc.filter(value => !this.replyCc.includes(value)), bcc: [...current.bcc] };
    const removedReplyKeys = new Set(this.replyCc.map(recipientKey));
    this.replyCc = [];
    // Only restore defaults previously shadowed by the implicit Reply All list.
    // Saved drafts and accepted recipients from partial sends must not gain recipients.
    if (this.mayAddDefaults && this.account) this.add({
      id: this.account.id,
      default_cc: this.account.default_cc?.filter(value => removedReplyKeys.has(recipientKey(value))),
      default_bcc: this.account.default_bcc?.filter(value => removedReplyKeys.has(recipientKey(value))),
    }, next, pending);
    if (all) {
      const occupied = new Set([...fields.flatMap(field => next[field].map(recipientKey)), ...pendingKeys(pending), ...this.dismissed]);
      for (const value of candidates) {
        const key = recipientKey(value);
        if (occupied.has(key)) continue;
        next.cc.push(value); this.replyCc.push(value); occupied.add(key);
      }
    }
    return next;
  }
}
