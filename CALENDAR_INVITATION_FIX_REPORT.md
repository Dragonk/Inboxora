# Inboxora — raport: wysyłka zaproszeń i opis wydarzenia (DSH)

Gałąź: `dev`. Zakres: naprawa błędu zapisu wydarzenia z zaproszeniem oraz
ujednolicenie opisu wydarzenia z mechanizmem wyświetlania treści wiadomości.

---

## 1. Błąd „The event and invitation could not be saved” — przyczyna

Zgłoszony błąd pochodzi z `backend/src/routes/calendar.js` (POST `/events` oraz
PATCH `/events/:eventId`, gałąź z `x-idempotency-key`). Oba miejsca zwracały 500
z komunikatem „…no partial changes were kept”, a transakcja faktycznie kończyła
się wyjątkiem PostgreSQL.

**Przyczyna: `attendees` jest kolumną `jsonb`, a do zapytania trafiała surowa
tablica JavaScript.**

`node-postgres` serializuje tablicę JS jako **literał tablicy PostgreSQL**
(`{admin@kmms.ovh}`), a nie jako JSON. Skutki (odtworzone na żywym PostgreSQL —
`backend/verify-calendar-jsonb.tmp.mjs`, usunięty po weryfikacji):

| Wartość przekazana | Wynik |
|---|---|
| `['admin@kmms.ovh']` | `ERROR: invalid input syntax for type json` |
| `[]` | **ciche zapisanie obiektu `{}`** (nie tablicy) |

To dokładnie pasuje do zgłoszenia: lista uczestników niepusta, więc
`INSERT`/`UPDATE` z `$14`/`$11` wywalał się w transakcji, a użytkownik widział
„Ponów zapis”. Dodatkowo zapisy bez zaproszeń (`attendees = []`) zapisywały
`{}`, co psuło `jsonb_array_length(attendees)` przy późniejszej edycji.

Kod wysyłki zaproszenia był poprawny — błąd następował **przed** wysyłką, na
etapie zapisu.

## 2. Naprawa

- `jsonbAttendees()` — każda wartość uczestników jest serializowana do JSON
  (`JSON.stringify`) w **czterech** miejscach zapisu: POST (z i bez
  idempotencji) oraz PATCH (przez `updateInvitedEvent` i ścieżkę zwykłą).
- `READ_ATTENDEES` — odczyt zwraca `'[]'::jsonb` dla wierszy, które zdążyły
  zapisać `{}`, więc istniejące rekordy dają się dalej edytować.
- `ATTENDEES_IS_ARRAY` — `jsonb_array_length()` jest wołane wyłącznie dla
  tablicy (`CASE ... WHEN jsonb_typeof(attendees) = 'array'`).
- Log transakcji zawiera teraz kod błędu PostgreSQL (`code`), żeby kolejny taki
  przypadek był rozpoznawalny z logu, a nie tylko po komunikacie użytkownika.

Weryfikacja na żywym PostgreSQL (CHECK constraints, `jsonb_typeof`, kolejność
`invitation_sequence`, aktualizacja wiersza z `{}`): **8/8 sprawdzeń OK**.

## 3. Opis wydarzenia = ten sam mechanizm co treść wiadomości

Opis był dotąd wyświetlany jako `<p style="white-space: pre-wrap">`, więc treść
HTML z maila (np. `X-ALT-DESC` z Outlooka albo HTML wprost w `DESCRIPTION`)
pokazywała surowe znaczniki. Teraz:

**Edycja** — `frontend/src/components/RichTextEditor.jsx`, edytor WYSIWYG na tym
samym stosie Tiptap, którego używa okno tworzenia wiadomości (StarterKit,
lista punktowana/numerowana, link, czyszczenie formatowania). Zapisuje HTML.

**Podgląd** — `MessageBodyRenderer` (sanityzowany iframe, CSP, bez skryptów,
skalowanie obrazów zdalnych jak w mailu) w:
- podglądzie wydarzenia tylko do odczytu w kalendarzu,
- karcie zaproszenia w czytniku wiadomości (`CalendarInvitationCard`).

**Zapis i wymiana (backend)** — `backend/src/utils/richText.js`:
- `isHtmlDescription()` rozpoznaje wyłącznie prawdziwe znaczniki (samo `<` albo
  „a > b” w tekście pisanym ręcznie nadal jest tekstem),
- `normalizeDescription()` sanityzuje HTML **tym samym** policy co treść
  wiadomości (`sanitizeComposeBody`),
- `descriptionContentLines()` zapisuje opis jako parę zgodną z RFC 5545:
  tekst w `DESCRIPTION` + `X-ALT-DESC;FMTTYPE=text/html` — klienci bez obsługi
  HTML nadal czytają sensowny tekst, a klienci HTML formatowanie.

**Odczyt (backend)** — `parseCalendarEvent()` i `calendarDescription()`
preferują `X-ALT-DESC;FMTTYPE=text/html`, a wynik sanityzują, więc zaproszenie
przyjęte z maila od razu renderuje się jak wiadomość. Wcześniej
`calendarDescription()` spłaszczał HTML do tekstu — teraz zachowuje formatowanie
bez skryptów i `javascript:`.

## 4. Pliki

Backend: `routes/calendar.js`, `utils/richText.js` (nowy),
`utils/richText.test.js` (nowy), `utils/ical.js`, `utils/calendarRecurrence.js`
(bez zmian — korzysta z `ical.js`), `services/calendarInvitation.js`,
`services/calendarFeed.js`, `routes/calendar.test.js`,
`utils/calendarRecurrence.test.js`.

Frontend: `components/RichTextEditor.jsx` (nowy), `utils/richText.js` (nowy),
`utils/richText.test.js` (nowy), `components/CalendarPage.jsx`,
`components/CalendarInvitationCard.jsx`, `components/calendarView.js`,
`index.css`, `locales/*.json` (9 języków).

## 5. Testy i obrazy

- backend: `npx vitest run` — 1673 przechodzi, 13 pominiętych;
- frontend: `npm test` — 2153 przechodzi; `npm run build` — OK;
- `eslint --max-warnings 0` — backend i frontend bez ostrzeżeń;
- nowe obrazy `:dev`: `ghcr.io/dragonk/inboxora-backend:dev` oraz
  `ghcr.io/dragonk/inboxora-frontend:dev`, zbudowane z commita tej naprawy
  (etykieta `org.opencontainers.image.revision` = SHA commita).
