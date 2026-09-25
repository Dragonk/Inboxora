/**
 * Canonical public OAuth/webhook URLs. APP_URL is the only source of truth.
 * Historical MS_REDIRECT_URI/MS_PROVIDER_REDIRECT_URI/GOOGLE_REDIRECT_URI values
 * are deliberately not consulted, so stored 4.0.x/dev configuration cannot
 * disagree with the URL the running server actually uses.
 */
export interface ProviderCallbackUrls {
  appUrl: string;
  microsoftCallback: string;
  googleCallback: string;
  legacyMicrosoftProviderCallback: string;
  microsoftWebhook: string;
  googleCalendarWebhook: string;
  gmailWebhook: string;
}

export function publicAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return ''; }
  const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && localhost)) return '';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  return parsed.toString().replace(/\/$/, '');
}

export function providerCallbackUrls(env: NodeJS.ProcessEnv = process.env): ProviderCallbackUrls {
  const appUrl = publicAppUrl(env);
  const at = (path: string) => appUrl ? `${appUrl}${path}` : '';
  return {
    appUrl,
    microsoftCallback: at('/oauth/microsoft/callback'),
    googleCallback: at('/oauth/google/callback'),
    legacyMicrosoftProviderCallback: at('/oauth/provider/microsoft/callback'),
    microsoftWebhook: at('/api/provider-webhooks/microsoft'),
    googleCalendarWebhook: at('/api/provider-webhooks/google-calendar'),
    gmailWebhook: at('/api/provider-webhooks/gmail'),
  };
}
