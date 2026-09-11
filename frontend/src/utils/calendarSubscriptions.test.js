import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLIDAY_CALENDARS,
  HOLIDAY_SYNC_INTERVAL_MIN,
  THUNDERBIRD_HOLIDAY_URL_BASE,
  defaultHolidayCountry,
  holidayCalendarUrl,
  holidayCountryName,
  normalizeSubscriptionUrl,
} from './calendarSubscriptions.js';

describe('calendar subscription URL handling', () => {
  it('builds a Thunderbird holiday ICS URL from the calendar file name', () => {
    assert.equal(holidayCalendarUrl('PolishHolidays'), 'https://www.thunderbird.net/media/caldata/autogen/PolishHolidays.ics');
    assert.ok(THUNDERBIRD_HOLIDAY_URL_BASE.endsWith('/'));
  });

  it('turns a webcal:// link into the https:// URL the server fetches', () => {
    assert.equal(normalizeSubscriptionUrl('webcal://example.test/team.ics'), 'https://example.test/team.ics');
    assert.equal(normalizeSubscriptionUrl('WEBCAL://example.test/team.ics'), 'https://example.test/team.ics');
  });

  it('leaves http(s) URLs untouched and trims surrounding whitespace', () => {
    assert.equal(normalizeSubscriptionUrl('  https://example.test/team.ics  '), 'https://example.test/team.ics');
    assert.equal(normalizeSubscriptionUrl('http://example.test/team.ics'), 'http://example.test/team.ics');
  });

  it('reports an empty URL for empty input instead of inventing one', () => {
    assert.equal(normalizeSubscriptionUrl(''), '');
    assert.equal(normalizeSubscriptionUrl('   '), '');
    assert.equal(normalizeSubscriptionUrl(null), '');
    assert.equal(normalizeSubscriptionUrl(undefined), '');
  });
});

describe('Thunderbird holiday catalog', () => {
  it('has one unique ISO code and ICS file per entry', () => {
    const codes = HOLIDAY_CALENDARS.map(entry => entry.code);
    const files = HOLIDAY_CALENDARS.map(entry => entry.file);
    assert.equal(new Set(codes).size, codes.length);
    assert.equal(new Set(files).size, files.length);
    assert.ok(HOLIDAY_CALENDARS.length > 40, 'a broad country list is offered');
  });

  it('resolves every entry to an HTTPS Thunderbird feed', () => {
    for (const entry of HOLIDAY_CALENDARS) {
      const url = holidayCalendarUrl(entry.file);
      assert.match(url, /^https:\/\/www\.thunderbird\.net\/media\/caldata\/autogen\/[A-Za-z0-9]+\.ics$/);
    }
  });

  it('polls holiday feeds rarely, because they change rarely', () => {
    assert.equal(HOLIDAY_SYNC_INTERVAL_MIN, 1440);
  });

  it('localizes the country name at runtime instead of bundling translations', () => {
    assert.equal(holidayCountryName('PL', 'en'), 'Poland');
    assert.equal(holidayCountryName('PL', 'pl'), 'Polska');
    assert.equal(holidayCountryName('PL', 'de'), 'Polen');
    // zhCN is the resource id, not a BCP 47 tag: it has to be spelled out first.
    assert.equal(holidayCountryName('CN', 'zhCN'), '中国');
  });

  it('falls back to the country code for an unknown region', () => {
    assert.equal(holidayCountryName('XX', 'en'), 'XX');
  });

  it('preselects the country implied by the interface language', () => {
    assert.equal(defaultHolidayCountry('pl'), 'PL');
    assert.equal(defaultHolidayCountry('de'), 'DE');
    assert.equal(defaultHolidayCountry('fr'), 'FR');
    assert.equal(defaultHolidayCountry('zhCN'), 'CN');
    assert.equal(defaultHolidayCountry('!!!'), 'PL');
  });
});
