// Public holiday calendars published by the Thunderbird project.
//
// Inboxora deliberately does not ship or generate a holiday database: doing so would
// mean tracking moving feasts, statutory changes and regional variants forever. Picking
// a country here only resolves to the matching read-only ICS feed, which the ordinary
// external-calendar sync then pulls like any other subscription. Keeping this to a URL
// map means a change upstream is a one-line edit, not a holiday-database rewrite.
//
// Source: https://www.thunderbird.net/calendar/holidays/
export const THUNDERBIRD_HOLIDAY_URL_BASE = 'https://www.thunderbird.net/media/caldata/autogen/';

// Public holiday calendars change once a year at most, so they are polled daily; the
// cadence stays editable per source in the calendar panel like any other subscription.
export const HOLIDAY_SYNC_INTERVAL_MIN = 1440;

// ISO 3166-1 alpha-2 codes, the Thunderbird calendar file name, and nothing else: the
// country name is localized at runtime with Intl.DisplayNames instead of being
// duplicated in every locale file.
export const HOLIDAY_CALENDARS = [
  { code: 'AL', file: 'AlbaniaHolidays' },
  { code: 'DZ', file: 'AlgeriaHolidays' },
  { code: 'AR', file: 'ArgentinaHolidays' },
  { code: 'AM', file: 'ArmeniaHolidays' },
  { code: 'AU', file: 'AustraliaHolidays' },
  { code: 'AT', file: 'AustrianHolidays' },
  { code: 'BE', file: 'BelgianHolidays' },
  { code: 'BO', file: 'BoliviaHolidays' },
  { code: 'BR', file: 'BrazilHolidays' },
  { code: 'BG', file: 'BulgarianHolidays' },
  { code: 'CA', file: 'CanadaHolidays' },
  { code: 'CL', file: 'ChileHolidays' },
  { code: 'CN', file: 'ChinaHolidays' },
  { code: 'CO', file: 'ColombianHolidays' },
  { code: 'CR', file: 'CostaRicaHolidays' },
  { code: 'HR', file: 'CroatiaHolidays' },
  { code: 'CZ', file: 'CzechHolidays' },
  { code: 'DK', file: 'DenmarkHolidays' },
  { code: 'DO', file: 'DominicanRepublicHolidays' },
  { code: 'NL', file: 'DutchHolidays' },
  { code: 'EE', file: 'EstoniaHolidays' },
  { code: 'FI', file: 'FinlandHolidays' },
  { code: 'FR', file: 'FrenchHolidays' },
  { code: 'DE', file: 'GermanHolidays' },
  { code: 'GR', file: 'GreeceHolidays' },
  { code: 'GY', file: 'GuyanaHolidays' },
  { code: 'HT', file: 'HaitiHolidays' },
  { code: 'HK', file: 'HongKongHolidays' },
  { code: 'HU', file: 'HungarianHolidays' },
  { code: 'IS', file: 'IcelandHolidays' },
  { code: 'IN', file: 'IndiaHolidays' },
  { code: 'ID', file: 'IndonesiaHolidays' },
  { code: 'IE', file: 'IrelandHolidays' },
  { code: 'IL', file: 'IsraelHolidays' },
  { code: 'IT', file: 'ItalianHolidays' },
  { code: 'JP', file: 'JapanHolidays' },
  { code: 'KZ', file: 'KazakhstanHolidaysEnglish' },
  { code: 'KE', file: 'KenyaHolidays' },
  { code: 'LV', file: 'LatviaHolidays' },
  { code: 'LB', file: 'LebanonHolidays' },
  { code: 'LI', file: 'LiechtensteinHolidays' },
  { code: 'LT', file: 'LithuanianHolidays' },
  { code: 'LU', file: 'LuxembourgHolidaysGerman' },
  { code: 'MY', file: 'MalaysiaHolidays' },
  { code: 'MT', file: 'MaltaHolidays' },
  { code: 'MX', file: 'MexicoHolidays' },
  { code: 'MA', file: 'MoroccoHolidays' },
  { code: 'NA', file: 'NamibiaHolidays' },
  { code: 'NZ', file: 'NewZealandHolidays' },
  { code: 'NI', file: 'NicaraguaHolidays' },
  { code: 'NO', file: 'NorwegianHolidays' },
  { code: 'PK', file: 'PakistanHolidays' },
  { code: 'PE', file: 'PeruHolidays' },
  { code: 'PH', file: 'PhilippinesHolidays' },
  { code: 'PL', file: 'PolishHolidays' },
  { code: 'PT', file: 'PortugalHolidays' },
  { code: 'PR', file: 'PuertoRicoHolidays' },
  { code: 'RO', file: 'RomaniaHolidays' },
  { code: 'RU', file: 'RussiaHolidays' },
  { code: 'SG', file: 'SingaporeHolidays' },
  { code: 'SK', file: 'SlovakHolidays' },
  { code: 'SI', file: 'SlovenianHolidays' },
  { code: 'ZA', file: 'SouthAfricaHolidays' },
  { code: 'KR', file: 'SouthKoreaHolidays' },
  { code: 'ES', file: 'SpainHolidays' },
  { code: 'LK', file: 'SriLankaHolidays' },
  { code: 'SE', file: 'SwedishHolidays' },
  { code: 'CH', file: 'SwissHolidays' },
  { code: 'TW', file: 'TaiwanHolidays' },
  { code: 'TH', file: 'ThailandHolidays' },
  { code: 'TT', file: 'TrinidadandTobagoHolidays' },
  { code: 'TR', file: 'TurkeyHolidays' },
  { code: 'GB', file: 'UKHolidays' },
  { code: 'US', file: 'USHolidays' },
  { code: 'UA', file: 'UkraineHolidays' },
  { code: 'UY', file: 'UruguayHolidays' },
  { code: 'VN', file: 'VietnamHolidays' },
];

export function holidayCalendarUrl(file) {
  return `${THUNDERBIRD_HOLIDAY_URL_BASE}${file}.ics`;
}

// The calendar panel already normalizes webcal:// on the server, but doing it here keeps
// the value the user sees and the value stored in the form in step, and it means the
// URL field accepts the exact string a website hands out.
export function normalizeSubscriptionUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  if (/^webcal:\/\//i.test(raw)) return `https://${raw.slice('webcal://'.length)}`;
  return raw;
}

const LOCALE_OVERRIDES = { zhCN: 'zh-CN' };

// Preselect the country that matches the interface language when it is one of the
// feeds we know, so the common case is one less decision. `Intl.Locale.maximize()`
// turns a bare language (pl, de, fr) into a likely region (PL, DE, FR).
export function defaultHolidayCountry(locale) {
  const known = new Set(HOLIDAY_CALENDARS.map(entry => entry.code));
  try {
    const region = new Intl.Locale(LOCALE_OVERRIDES[locale] || locale || 'en').maximize().region;
    if (region && known.has(region)) return region;
  } catch { /* Not a locale tag we can parse: fall back below. */ }
  return 'PL';
}

export function holidayCountryName(code, locale) {
  const candidates = [LOCALE_OVERRIDES[locale] || locale, 'en'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const display = new Intl.DisplayNames([candidate], { type: 'region' });
      const name = display.of(code);
      if (name && name !== code) return name;
    } catch { /* Unsupported locale or region code: fall through to the next candidate. */ }
  }
  return code;
}
