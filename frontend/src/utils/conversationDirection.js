function normalizedAddress(value) {
  const raw = typeof value === 'object' && value ? (value.email || value.address) : value;
  const text = String(raw || '').trim();
  const angle = text.match(/<([^>]+)>/);
  return String(angle?.[1] || text).trim().toLowerCase();
}

export function accountOwnAddresses(account, copy = null) {
  if (!account) return new Set();
  const addresses = [account.email_address, ...(account.aliases || []).map(alias => alias?.email || alias)];
  const delivered = copy?.deliveryAddresses ?? copy?.delivery_addresses ?? [];
  if (Array.isArray(delivered)) addresses.push(...delivered);
  return new Set(addresses.map(normalizedAddress).filter(Boolean));
}

export function directionFromAddress(fromEmail, ownAddresses) {
  const from = normalizedAddress(fromEmail);
  if (!from || !ownAddresses?.size) return null;
  return ownAddresses.has(from) ? 'outgoing' : 'incoming';
}

export function physicalCopyDirection(copy, account) {
  if (!copy || !account || String(copy.accountId ?? copy.account_id) !== String(account.id)) return null;
  return directionFromAddress(copy.fromEmail ?? copy.from_email, accountOwnAddresses(account, copy));
}

export function preferredAccountCopy(message, selectedAccountId, selectedCopyId = null) {
  const copies = (message?.copies || []).filter(copy => copy.accountId === selectedAccountId);
  return copies.find(copy => copy.id === selectedCopyId)
    || [...copies].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0]
    || null;
}
