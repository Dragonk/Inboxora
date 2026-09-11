import { it } from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { readFileSync } from 'node:fs';
import { contactDateLabel, localizeContactEvent, localizeContactCalendar } from './contactDateLabels.js';

for (const language of ['en', 'pl', 'de', 'fr', 'es', 'it', 'cs', 'ru', 'zhCN']) {
  it(`localizes contact-derived calendar events in ${language} without rewriting custom data`, async () => {
    const translation = JSON.parse(readFileSync(new URL(`../locales/${language}.json`, import.meta.url)));
    const i18n = i18next.createInstance();
    await i18n.init({ lng: language, resources: { [language]: { translation } } });
    const t = i18n.t.bind(i18n);
    const base = { source: 'contacts', calendar_id: 'contacts-birthdays', contact_name: 'Ada: Kowalska', summary: 'Birthday: Ada: Kowalska' };
    for (const [label, key] of [['Birthday', 'birthday'], ['Anniversary', 'anniversary'], ['Name day', 'nameDay']]) {
      const event = localizeContactEvent({ ...base, contact_date_label: label }, t);
      assert.ok(event.summary.includes(translation.contacts.fields[key]));
      assert.ok(event.summary.includes(base.contact_name));
    }
    assert.equal(localizeContactCalendar({ id: 'contacts-birthdays', source: 'contacts', custom_name: true, name: 'Rodzina' }, t).name, 'Rodzina');
    assert.equal(localizeContactEvent({ ...base, calendar_custom_name: true, calendar_name: 'Rodzina' }, t).calendar_name, 'Rodzina');
    assert.equal(contactDateLabel('Ślub: cywilny', t), 'Ślub: cywilny');
    assert.ok(localizeContactEvent({ ...base, contact_date_label: 'Ślub: cywilny' }, t).summary.includes('Ślub: cywilny'));
    assert.equal(localizeContactEvent({ source: 'local', summary: 'Birthday: meeting' }, t).summary, 'Birthday: meeting');
    assert.equal(localizeContactCalendar({ id: 'contacts-birthdays', source: 'contacts' }, t).name, translation.calendar.contactDates);
    assert.ok(localizeContactEvent({ ...base, contact_date_label: 'Birthday', contact_name: null }, t).summary.includes(translation.calendar.unnamedContact));
    assert.ok(localizeContactEvent({ ...base, contact_name: undefined }, t).summary.includes(translation.contacts.fields.birthday));
  });
}

it('formats a birthday without a year in the selected language', async () => {
  const { formatContactDate } = await import('./contactDateLabels.js');
  assert.equal(formatContactDate('--02-29', 'pl-PL'), '29 lutego');
  assert.equal(formatContactDate('--02-29', 'en-US'), 'February 29');
});
