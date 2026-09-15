import { expect } from '@playwright/test';

export const richContact = {
  id: 'v3-anna', display_name: 'Anna Kowalska', first_name: 'Anna', last_name: 'Kowalska',
  primary_email: 'anna@example.test', address_book_id: 'book-work', organization: 'Studio Forma',
  title: 'Projektantka', role: 'Koordynacja', nickname: 'Ania', read_only: false,
  emails: [{ value: 'anna@example.test', type: 'work', primary: true }, { value: 'anna.private@example.test', type: 'home' }],
  phones: [{ value: '+48 600 123 456', type: 'mobile' }],
  urls: [{ value: 'https://example.test', type: 'work' }],
  instantMessages: [{ value: 'anna:example.test', type: 'Matrix' }],
  addresses: [{ type: 'work', pobox: '42', extended: 'Piętro 2', street: 'Długa 12', locality: 'Warszawa', region: 'Mazowieckie', postalCode: '00-001', country: 'Polska' }],
  contactDates: [{ label: 'Birthday', value: '1990-09-10' }, { label: 'Anniversary', value: '2018-06-12' }, { label: 'Name day', value: '2026-07-26' }],
  categories: ['Projekt', 'Zespół'], notes: 'Kontakt w sprawie projektu strony. Preferuje kontakt rano.',
  send_count: 12, last_sent: '2026-09-08T10:00:00Z',
};

export async function setupV3(page) {
  page.__themeOverride = 'ink';
  await page.clock.setFixedTime(new Date('2026-09-10T10:15:00Z'));
  const requests = { events: [], contacts: [], saves: [] };
  let contact = structuredClone(richContact);
  const books = [{ id: 'book-work', name: 'Firmowa', source: 'local', visible: true }, { id: 'book-private', name: 'Prywatna', source: 'local', visible: true }];
  const calendars = [
    { id: 'calendar-personal', name: 'Osobisty', color: '#35548a', source: 'local', read_only: false, owner_user_id: 'e2e-user' },
    { id: 'calendar-remote', name: 'Zespół · CalDAV', color: '#35793a', source: 'caldav', read_only: true },
  ];
  let events = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `v3-event-${index}`, calendar_id: 'calendar-personal', calendar_color: '#35548a', source: 'local', read_only: false, summary: ['Planowanie projektu', 'Przegląd makiet', 'Spotkanie zespołu', 'Rozmowa z klientem', 'Podsumowanie dnia'][index], location: 'Studio Forma', description: 'Omówienie następnych kroków.', starts_at: `2026-09-10T${String(8 + index).padStart(2, '0')}:00:00Z`, ends_at: `2026-09-10T${String(9 + index).padStart(2, '0')}:30:00Z` })),
    { id: 'v3-remote', calendar_id: 'calendar-remote', calendar_color: '#35793a', source: 'caldav', read_only: true, summary: 'Wyjazd zespołu', description: 'Wydarzenie ze źródła CalDAV.', all_day: true, starts_at: '2026-09-10T00:00:00Z', ends_at: '2026-09-12T00:00:00Z' },
    { id: 'v3-next-month', calendar_id: 'calendar-personal', source: 'local', summary: 'Plan października', starts_at: '2026-10-01T09:00:00Z', ends_at: '2026-10-01T10:00:00Z' },
  ];
  await page.route('**/api/calendar/calendars', route => route.fulfill({ json: { calendars } }));
  await page.route('**/api/calendar/events**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'GET') {
      requests.events.push({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
      const from = new Date(url.searchParams.get('from')); const to = new Date(url.searchParams.get('to'));
      return route.fulfill({ json: { events: events.filter(event => new Date(event.starts_at) < to && new Date(event.ends_at) > from) } });
    }
    const id = url.pathname.split('/').at(-1);
    if (request.method() === 'DELETE') { events = events.filter(event => event.id !== id); return route.fulfill({ json: { ok: true } }); }
    const body = request.postDataJSON(); requests.saves.push(body);
    const event = { ...body, id: id === 'events' ? 'created-event' : id, starts_at: body.startsAt, ends_at: body.endsAt, all_day: body.allDay, calendar_id: body.calendarId, calendar_color: '#35548a', source: 'local', read_only: false };
    events = [...events.filter(item => item.id !== event.id), event];
    return route.fulfill({ json: { event, id: event.id } });
  });
  await page.route('**/api/calendar/sources**', route => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/contacts**', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.includes('address-books')) {
      if (request.method() === 'PATCH') Object.assign(books.find(book => url.pathname.endsWith(book.id)), request.postDataJSON());
      return route.fulfill({ json: { addressBooks: books } });
    }
    if (request.method() === 'PUT' || request.method() === 'POST' || request.method() === 'PATCH') {
      const body = request.postDataJSON(); requests.contacts.push(body);
      contact = { ...contact, ...body, display_name: body.displayName, first_name: body.firstName, last_name: body.lastName };
      return route.fulfill({ json: contact });
    }
    if (url.pathname.endsWith('/v3-anna')) return route.fulfill({ json: contact });
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const visible = (!url.searchParams.get('addressBookId') || url.searchParams.get('addressBookId') === 'book-work') && JSON.stringify(contact).toLowerCase().includes(q);
    return route.fulfill({ json: { contacts: visible ? [contact] : [], total: visible ? 1 : 0 } });
  });
  return requests;
}

export async function navigateModule(page, module) {
  const mobile = page.viewportSize().width < 768;
  if (mobile) await page.getByTestId('mobile-topbar-menu').click();
  await page.getByTestId(`${module}-nav-${mobile ? 'mobile' : 'primary'}`).click();
  await expect(page.getByTestId(module === 'calendar' ? 'calendar-page' : 'contacts-list-scroll')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
