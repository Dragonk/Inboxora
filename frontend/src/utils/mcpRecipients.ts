import { recipientKey } from './defaultRecipients.ts';

/** Split comma/semicolon/newline separators, but preserve commas inside quoted display names. */
export function parseMcpRecipients(value: string): string[] {
  const parts = value
    .split(/[,;\n](?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(item => item.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return parts.filter(item => {
    const key = recipientKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
