export interface CalendarSenderAccount {
  id: string; name?: unknown; email_address?: string | null; enabled?: unknown;
  smtp_host?: unknown; mail_transport?: unknown;
  aliases?: Array<{ id: string; email?: string | null; name?: string | null }>;
}
export interface CalendarSender { value: string; accountId: string; aliasId: string; email: string; label: string }
export function calendarSenderValue(accountId: string, aliasId = ''): string {
  return accountId ? `${accountId}${aliasId ? `:${aliasId}` : ''}` : '';
}
export function calendarSenders(accounts: readonly CalendarSenderAccount[]): CalendarSender[] {
  return accounts.filter(account => account.enabled && (account.smtp_host
    || account.mail_transport === 'gmail_api' || account.mail_transport === 'microsoft_graph')).flatMap(account => {
    const email = account.email_address || '';
    const label = typeof account.name === 'string' && account.name ? `${account.name} · ${email}` : email;
    return [{ value: account.id, accountId: account.id, aliasId: '', email, label },
      ...(account.aliases || []).filter(alias => Boolean(alias.email)).map(alias => ({
        value: calendarSenderValue(account.id, alias.id), accountId: account.id, aliasId: alias.id,
        email: alias.email || '', label: `${alias.name || account.name || email} · ${alias.email}`,
      }))];
  });
}
