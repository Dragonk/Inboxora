// Rules engine for the antispam classifier — Layer 1, always-on.
//
// 14 hand-crafted heuristic rules as pure functions. The engine provides a
// deterministic baseline that works even with zero ML training records.
// Auth results are honored only from a trusted authserv-id; with none
// configured the auth signal is neutral.
//
// Adapted from upstream MailFlow v0.2 for Inboxora (strict TypeScript).

import { parseAuthResults, hasTrustedAuthResults } from './spamParser.js';
import { EXECUTABLE_EXTENSIONS } from './spamTokenizer.js';
import type { SpamMessageInput, SpamAttachment } from './spamTokenizer.js';

const PHARMA_KEYWORDS: ReadonlyArray<string> = [
  'viagra', 'cialis', 'kamagra', 'levitra', 'pharmacy', 'pharmacies',
  'prescription', 'xanax', 'valium', 'oxycontin', 'oxycodone', 'percocet',
  'sildenafil', 'tadalafil', 'finasteride', 'weight loss', 'diet pill',
  'farmacia', 'ricetta medica', 'dimagrire', 'pillola dimagrante',
  'apotheke', 'rezeptpflichtig', 'abnehmen',
  'receta medica', 'adelgazar',
  'pharmacie', 'ordonnance', 'mincir',
  'виагра', 'сиалис', 'аптека', 'рецепт',
  '伟哥', '希爱力', '药店', '处方药', '减肥药',
];

const MONEY_KEYWORDS: ReadonlyArray<string> = [
  'lottery', 'winner', 'you won', 'you have won', 'prize', 'jackpot',
  'claim your', 'claim now', 'million dollars', 'million euros', 'free money',
  'cash prize', 'inheritance', 'beneficiary', 'wire transfer', 'nigerian prince',
  '$$$', '€€€', '£££',
  'lotteria', 'vincitore', 'hai vinto', 'premio', 'denaro gratis', 'eredità', 'beneficiario', 'bonifico',
  'lotterie', 'gewinn', 'sie haben gewonnen', 'preis', 'preisgeld',
  'kostenloses geld', 'erbschaft',
  'lotería', 'ganador', 'has ganado', 'dinero gratis',
  'herencia', 'transferencia',
  'loterie', 'gagnant', 'vous avez gagné', 'prix', 'argent gratuit',
  'héritage', 'virement',
  'лотерея', 'победитель', 'вы выиграли', 'приз', 'бесплатные деньги',
  'наследство', 'денежный перевод',
  '彩票', '中奖', '您已中奖', '奖金', '免费赠品', '遗产', '汇款',
];

const BODY_SPAM_PHRASES: ReadonlyArray<string> = [
  'click here', 'click the link', 'click below',
  'buy now', 'order now', 'shop now',
  'limited time', 'limited offer', 'act now', 'act fast',
  'risk free', 'risk-free', 'no risk', '100% free', 'absolutely free',
  'guaranteed', 'satisfaction guaranteed',
  'no obligation', 'no purchase necessary',
  'congratulations', 'you have been selected',
  'this is not spam', 'this is not a scam',
  'unsubscribe below', 'remove me from this list',
  'make money', 'earn money', 'extra cash', 'work from home',
  'lose weight', 'miracle', 'cure',
  'clicca qui', 'clicca sotto', 'acquista ora', 'ordina ora',
  'offerta limitata', 'offerta a tempo', 'agisci ora', 'agisci subito',
  'senza rischi', 'senza impegno', 'senza obbligo',
  'complimenti', 'sei stato selezionato',
  'guadagnare', 'lavorare da casa', 'dimagrire',
  'hier klicken', 'jetzt kaufen', 'limitierte zeit', 'jetzt handeln',
  'risikofrei', 'ohne verpflichtung',
  'herzlichen glückwunsch', 'sie wurden ausgewählt',
  'geld verdienen', 'von zuhause arbeiten', 'abnehmen',
  'haga clic aquí', 'compre ahora', 'oferta limitada', 'actúe ahora',
  'sin compromiso', 'sin riesgo',
  'felicidades', 'ha sido seleccionado',
  'ganar dinero', 'trabajar desde casa', 'adelgazar',
  'cliquez ici', 'achetez maintenant', 'offre limitée', 'agissez maintenant',
  'sans engagement', 'sans risque',
  'félicitations', 'vous avez été sélectionné',
  "gagner de l'argent", 'travailler depuis chez soi', 'mincir',
  'нажмите здесь', 'купить сейчас', 'ограниченное время', 'действуйте сейчас',
  'без обязательств', 'без риска',
  'поздравляем', 'вы были выбраны',
  'заработать деньги', 'работать из дома', 'похудеть',
  '点击这里', '立即购买', '限时优惠', '立即行动',
  '无风险', '无义务',
  '恭喜', '您已被选中',
  '赚钱', '在家工作', '减肥',
];

const URL_SHORTENERS: ReadonlySet<string> = new Set([
  'bit.ly', 'tinyurl.com', 'ow.ly', 't.co', 'goo.gl',
  'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at',
  'rb.gy', 'trib.al', 'short.io', 'lnkd.in', 'fb.me',
  'youtu.be', 'tiny.cc', 'bl.ink', 'soo.gd', 's.id', 'v.gd',
]);

const PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'txt', 'rtf', 'odt', 'ods', 'odp', 'jpg', 'jpeg', 'png', 'gif',
  'mp3', 'mp4', 'mov', 'avi', 'wav',
]);

const DKIM_NEGATIVE_RESULTS: ReadonlySet<string | null> = new Set(['fail', 'hardfail', 'permerror', 'softfail', 'absent', null]);
const SPF_NEGATIVE_RESULTS: ReadonlySet<string | null> = new Set(['fail', 'softfail', 'permerror', 'temperror', 'absent', null]);
const DMARC_NEGATIVE_RESULTS: ReadonlySet<string | null> = new Set(['fail', 'permerror', 'temperror', 'absent', null]);

function normalizeSubject(subject: unknown): string {
  return String(subject ?? '').toLowerCase().normalize('NFC');
}

function normalizeBody(body: unknown): string {
  return String(body ?? '').toLowerCase().normalize('NFC');
}

function hasWordBoundaryKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(text);
}

function extractDomain(address: unknown): string | null {
  if (address === null || address === undefined) return null;
  const text = String(address);
  const angle = /<([^<>]+)>/.exec(text);
  const addr = (angle?.[1] ?? text).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  return addr.slice(at + 1).toLowerCase() || null;
}

const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'com.br', 'com.mx', 'com.ar', 'co.in', 'com.sg',
  'com.hk', 'co.za', 'com.tr', 'com.pl', 'co.kr',
]);

function registrableDomain(domain: string | null): string | null {
  if (!domain) return null;
  const labels = domain.split('.');
  if (labels.length <= 2) return domain;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function attachmentExtension(filename: unknown): string | null {
  const base = String(filename ?? '').trim();
  const lastDot = base.lastIndexOf('.');
  if (lastDot > 0 && lastDot < base.length - 1) {
    return base.slice(lastDot + 1).toLowerCase();
  }
  return null;
}

function listOfHeaders(headers: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (Array.isArray(headers)) {
    for (const line of headers) {
      const m = /^([^:]+):\s*(.*)$/.exec(String(line));
      if (m?.[1]) map[m[1].toLowerCase()] = (map[m[1].toLowerCase()] ?? '') + ' ' + (m[2] ?? '');
    }
    return map;
  }
  if (headers !== null && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      map[String(key).toLowerCase()] = Array.isArray(value) ? value.join(' ') : String(value);
    }
  }
  return map;
}

function hasAuthHeader(headers: unknown, trustedAuthservIds: unknown): boolean {
  return hasTrustedAuthResults(headers as Parameters<typeof hasTrustedAuthResults>[0], trustedAuthservIds);
}

function hasMailingListHeaders(headers: unknown): boolean {
  const map = listOfHeaders(headers);
  const listId = (map['list-id'] ?? '').trim();
  const listUnsub = (map['list-unsubscribe'] ?? '').trim();
  if (!/^<[^<>]+>$/.test(listId)) return false;
  const unsubOptions = listUnsub.replace(/[<>]/g, '').split(',');
  return unsubOptions.some(opt => /^(mailto:|https?:\/\/)/.test(opt.trim()));
}

export interface SpamRuleEmail extends SpamMessageInput {
  subject?: string | null;
  body?: string | null;
  from?: string | null;
  replyTo?: string | null;
}

export interface SpamRuleContext {
  authResults?: { dkim: string | null; spf: string | null; dmarc: string | null };
  authHeaderPresent?: boolean;
  userContacts?: ReadonlySet<string>;
  trustedAuthservIds?: unknown;
  headers?: unknown;
}

interface SpamRule {
  name: string;
  weight: number;
  test: (email: SpamRuleEmail, ctx: Required<Pick<SpamRuleContext, 'authResults' | 'authHeaderPresent' | 'userContacts' | 'headers'>>) => boolean;
}

const RULES: ReadonlyArray<SpamRule> = [
  {
    name: 'SUBJECT_ALL_CAPS',
    weight: 0.3,
    test: (email) => {
      const subject = String(email.subject ?? '');
      const letters = (subject.match(/\p{L}/gu) ?? []).length;
      if (letters === 0) return false;
      const upper = (subject.match(/\p{Lu}/gu) ?? []).length;
      return upper / letters > 0.5;
    },
  },
  {
    name: 'SUBJECT_MANY_EXCLAMATIONS',
    weight: 0.2,
    test: (email) => {
      const subject = String(email.subject ?? '');
      const exclaims = (subject.match(/!/g) ?? []).length;
      return exclaims > 3 || /!{3,}/.test(subject);
    },
  },
  {
    name: 'SUBJECT_PHARMA_KEYWORDS',
    weight: 0.5,
    test: (email) => {
      const subject = normalizeSubject(email.subject);
      return PHARMA_KEYWORDS.some(kw => hasWordBoundaryKeyword(subject, kw));
    },
  },
  {
    name: 'SUBJECT_MONEY_KEYWORDS',
    weight: 0.4,
    test: (email) => {
      const subject = normalizeSubject(email.subject);
      return MONEY_KEYWORDS.some(kw => hasWordBoundaryKeyword(subject, kw));
    },
  },
  {
    name: 'BODY_SPAM_KEYWORDS',
    weight: 0.4,
    test: (email) => {
      const body = normalizeBody(email.body);
      if (!body) return false;
      const matched = BODY_SPAM_PHRASES.filter(phrase => body.includes(phrase));
      return new Set(matched).size >= 2;
    },
  },
  {
    name: 'BODY_URL_SHORTENER',
    weight: 0.3,
    test: (email) => {
      const body = String(email.body ?? '');
      const urls = body.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
      for (const url of urls) {
        try {
          const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
          if (URL_SHORTENERS.has(host)) return true;
        } catch { /* malformed URL, ignore */ }
      }
      return false;
    },
  },
  {
    name: 'FROM_REPLYTO_MISMATCH',
    weight: 0.4,
    test: (email) => {
      if (!email.replyTo) return false;
      const from = registrableDomain(extractDomain(email.from));
      const replyTo = registrableDomain(extractDomain(email.replyTo));
      return Boolean(from && replyTo && from !== replyTo);
    },
  },
  {
    name: 'ATTACHMENT_EXECUTABLE',
    weight: 0.6,
    test: (email) => {
      const attachments = Array.isArray(email.attachments) ? email.attachments : [];
      return attachments.some(a => {
        const ext = attachmentExtension((a as SpamAttachment).filename ?? (a as SpamAttachment).name);
        return ext !== null && EXECUTABLE_EXTENSIONS.has(ext);
      });
    },
  },
  {
    name: 'ATTACHMENT_DOUBLE_EXT',
    weight: 0.3,
    test: (email) => {
      const attachments = Array.isArray(email.attachments) ? email.attachments : [];
      return attachments.some(a => {
        const base = String((a as SpamAttachment).filename ?? (a as SpamAttachment).name ?? '').trim();
        const parts = base.split('.');
        if (parts.length < 3) return false;
        const last = (parts[parts.length - 1] ?? '').toLowerCase();
        const penultimate = (parts[parts.length - 2] ?? '').toLowerCase();
        return EXECUTABLE_EXTENSIONS.has(last) && PRESENTATION_EXTENSIONS.has(penultimate);
      });
    },
  },
  {
    name: 'AUTH_DKIM_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      Boolean(ctx.authHeaderPresent) && DKIM_NEGATIVE_RESULTS.has(ctx.authResults.dkim ?? null),
  },
  {
    name: 'AUTH_SPF_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      Boolean(ctx.authHeaderPresent) && SPF_NEGATIVE_RESULTS.has(ctx.authResults.spf ?? null),
  },
  {
    name: 'AUTH_DMARC_FAIL',
    weight: 0.4,
    test: (_email, ctx) =>
      Boolean(ctx.authHeaderPresent) && DMARC_NEGATIVE_RESULTS.has(ctx.authResults.dmarc ?? null),
  },
  {
    name: 'MAILING_LIST_HEADERS',
    weight: -0.2,
    test: (_email, ctx) => hasMailingListHeaders(ctx.headers),
  },
  {
    name: 'FROM_IN_USER_CONTACTS',
    weight: -0.5,
    test: (email, ctx) => {
      if (!ctx.userContacts || ctx.userContacts.size === 0) return false;
      const from = extractDomain(email.from);
      if (!from) return false;
      const normalized = normalizeContactAddress(email.from);
      return normalized !== null && ctx.userContacts.has(normalized);
    },
  },
];

export function normalizeContactAddress(address: unknown): string | null {
  if (address === null || address === undefined) return null;
  const text = String(address);
  const angle = /<([^<>]+)>/.exec(text);
  const raw = (angle?.[1] ?? text).trim().toLowerCase();
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  let stripped = local.split('+')[0] ?? local;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    stripped = stripped.replace(/\./g, '');
  }
  return `${stripped}@${domain}`;
}

const ATTACHMENT_RULES: ReadonlySet<string> = new Set(['ATTACHMENT_EXECUTABLE', 'ATTACHMENT_DOUBLE_EXT']);

export interface RulesScore {
  score: number;
  fired: Array<{ name: string; weight: number }>;
}

export function scoreRules(email: SpamRuleEmail, ctx: SpamRuleContext = {}): RulesScore {
  const headers = email.headers ?? [];
  const fullCtx = {
    authResults: parseAuthResults(headers as Parameters<typeof parseAuthResults>[0], { trustedAuthservIds: ctx.trustedAuthservIds }),
    authHeaderPresent: hasAuthHeader(headers, ctx.trustedAuthservIds),
    userContacts: ctx.userContacts ?? new Set<string>(),
    headers,
  };

  const fired = RULES.filter(rule => rule.test(email, fullCtx));

  const attachmentFired = fired.filter(r => ATTACHMENT_RULES.has(r.name));
  let rawScore = fired.reduce((sum, r) => sum + r.weight, 0);
  if (attachmentFired.length > 1) {
    const maxWeight = Math.max(...attachmentFired.map(r => r.weight));
    rawScore = rawScore - attachmentFired.reduce((s, r) => s + r.weight, 0) + maxWeight;
  }

  const score = Math.max(0, Math.min(1, rawScore));
  return { score, fired: fired.map(r => ({ name: r.name, weight: r.weight })) };
}

export function explainRules(email: SpamRuleEmail, ctx: SpamRuleContext = {}): Array<{ name: string; weight: number; fired: boolean }> {
  const headers = email.headers ?? [];
  const fullCtx = {
    authResults: parseAuthResults(headers as Parameters<typeof parseAuthResults>[0], { trustedAuthservIds: ctx.trustedAuthservIds }),
    authHeaderPresent: hasAuthHeader(headers, ctx.trustedAuthservIds),
    userContacts: ctx.userContacts ?? new Set<string>(),
    headers,
  };
  return RULES.map(rule => ({
    name: rule.name,
    weight: rule.weight,
    fired: rule.test(email, fullCtx),
  }));
}

export { RULES };
