/** A managed account's own identities (addresses that mean "outgoing" for this account). */
export interface AccountIdentity {
  id?: string | null;
  email_address?: string | null;
  aliases?: Array<{ email?: string | null; [key: string]: unknown }> | null;
}

/** The per-copy delivery fields that can extend a copy's own-address set. */
export interface DeliveryIdentityCopy {
  deliveryAddresses?: unknown;
  delivery_addresses?: unknown;
}

/** A physical copy as the direction resolver reads it. */
export interface ConversationCopyLike extends DeliveryIdentityCopy {
  id?: string | null;
  accountId?: string | null;
  account_id?: string | null;
  date?: string | number | Date | null;
  fromEmail?: string | null;
  from_email?: string | null;
  [key: string]: unknown;
}

/** An address as callers hold it: a raw string or a parsed { email, address } object. */
type AddressLike = string | { email?: unknown; address?: unknown } | null | undefined;

function normalizedAddress(value: AddressLike): string {
  const raw = typeof value === 'object' && value ? (value.email || value.address) : value;
  const text = String(raw || '').trim();
  const angle = text.match(/<([^>]+)>/);
  return String(angle?.[1] || text).trim().toLowerCase();
}

export function accountOwnAddresses(account: AccountIdentity | null | undefined, copy: DeliveryIdentityCopy | null = null) {
  if (!account) return new Set<string>();
  const addresses = [account.email_address, ...(account.aliases || []).map(alias => alias?.email || alias)];
  const delivered = copy?.deliveryAddresses ?? copy?.delivery_addresses ?? [];
  if (Array.isArray(delivered)) addresses.push(...delivered);
  return new Set(addresses.map(normalizedAddress).filter(Boolean));
}

export function directionFromAddress(fromEmail: AddressLike, ownAddresses: Set<string> | null | undefined) {
  const from = normalizedAddress(fromEmail);
  if (!from || !ownAddresses?.size) return null;
  return ownAddresses.has(from) ? 'outgoing' : 'incoming';
}

export function physicalCopyDirection(copy: ConversationCopyLike | null | undefined, account: AccountIdentity | null | undefined) {
  if (!copy || !account || String(copy.accountId ?? copy.account_id) !== String(account.id)) return null;
  return directionFromAddress(copy.fromEmail ?? copy.from_email, accountOwnAddresses(account, copy));
}

// NOTE: the message payload stays structurally open on purpose: callers pass the
// conversation logical message, whose copy projection is looser than ConversationCopyLike.
export function preferredAccountCopy(message, selectedAccountId: string | null | undefined, selectedCopyId: string | null | undefined = null) {
  if (selectedAccountId == null) return null;
  const copies = (message?.copies || []).filter((copy: ConversationCopyLike) => String(copy.accountId ?? copy.account_id) === String(selectedAccountId));
  return copies.find((copy: ConversationCopyLike) => String(copy.id) === String(selectedCopyId))
    || [...copies].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]
    || null;
}
