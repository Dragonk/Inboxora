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

- backend: `npx vitest run` — 1688 przechodzi, 13 pominiętych;
- frontend: `npm test` — 2159 przechodzi; `npm run build` — OK;
- `eslint --max-warnings 0` — pliki tej zmiany bez ostrzeżeń;
- nowe obrazy `:dev`: `ghcr.io/dragonk/inboxora-backend:dev` oraz
  `ghcr.io/dragonk/inboxora-frontend:dev`, zbudowane z commita tej naprawy
  (etykieta `org.opencontainers.image.revision` = SHA commita).

---

# Runda 2 — zaproszenie nie było wysyłane, opis z maila źle się renderował

## 6. Przyczyna: brak stanu „nie udało się” w outboxie

Zapis wydarzenia działał, ale **wiadomość nie wychodziła**, a „Ponów zapis” w GUI
odtwarzał zapisany błąd zamiast wysłać ponownie. Outbox znał tylko statusy
`sending` i `sent`:

- nieudana wysyłka zostawała na `sending` z `last_error`, bez harmonogramu
  ponowienia — więc kolejne identyczne żądanie nie mogło odróżnić „w trakcie”
  od „poddane” i **nigdy nie wysyłało ponownie**;
- `next_attempt_at` nie istniało, więc nie było czego ponawiać automatycznie;
- payload JSONB trzymał **cały wiersz konta** (z poświadczeniami), przez co
  zapisane ponowienie nie miało bezpiecznej drogi do nadawcy.

Potwierdzone end-to-end na żywym SMTP (skrzynka-sink) i na zbudowanym obrazie.

## 7. Naprawa

- migracja `0080_calendar_invitation_outbox_delivery.sql` — status `failed`
  + `next_attempt_at` + częściowy indeks; nieudane zaproszenie staje się
  **zakolejkowanym, ponawialnym** elementem, a nie martwym wierszem;
- `services/calendarInvitationOutbox.js` (nowy) — próby są zapisywane, porażki
  planowane z wykładniczym backoffem, a payload trzyma **tylko id konta**,
  rozwiązywane na nowo przy każdej próbie;
- identyczne ponowienie nieudanego zaproszenia **wysyła je ponownie**, ale
  zaproszenie już dostarczone nigdy nie leci drugi raz;
- worker w tle dociąga zaległe zaproszenia, więc chwilowa awaria SMTP leczy się
  bez otwierania wydarzenia;
- POST/PATCH i obie ścieżki „duplicate” zwracają realny stan dostarczenia
  (`invitationStatus` + `invitationError`).

## 8. Opis z maila renderuje się jak treść wiadomości

Opis tekstowy z zaproszenia Outlooka (bez HTML) szedł do `<pre>`, więc widać było
jeden ciąg z literalnym `&lt;https://…&gt;`. Teraz tekst przechodzi tę samą drogą
co HTML treści maila: akapity, łamania linii, a adresy w nawiasach ostrych
(`<https://…>`), `www.` i `mailto:` stają się prawdziwymi linkami; znaki
interpunkcyjne zostają poza linkiem, a `&` w adresie jest poprawnie escapowany.

## 9. Weryfikacja end-to-end (obraz + prawdziwy SMTP)

Na zbudowanym obrazie i skrzynce SMTP: 3 wydarzenia → **dokładnie 3 wiadomości,
zero duplikatów**; pierwsza próba na nieosiągalnym SMTP zapisała `failed` z
`next_attempt_at`, a ponowienie z tym samym kluczem idempotencji wysłało
`sent` bez duplikatu wydarzenia; powtórny zapis już dostarczonego zaproszenia
nie wysłał go drugi raz. Każdy załącznik ICS zawierał `DESCRIPTION` (tekst)
oraz `X-ALT-DESC;FMTTYPE=text/html`.

Uwaga: w drzewie roboczym znajdują się **cudze, niezcommitowane** zmiany
(m.in. `CalendarSidebar.jsx`, `panelWidth.js`, `MailApp.jsx`, `ui.jsx`) — nie
dotykałem ich i nie weszły do tego commita. Obrazy zbudowano z czystego drzewa
commita, nie z working tree.

---

# Runda 3 — odbiór zaproszenia z maila + spójny opis opcji w ustawieniach

## 10. Przyczyna: załącznik `.ics` nie był odkodowany

Karta zaproszenia w odbieranej skrzynce pokazywała „Nie udało się odczytać lub
zapisać zaproszenia”. `walkStructure()` dla części `text/calendar` dopisywał ją do
listy załączników **bez pola `encoding`**, a `fetchAttachment()` robiło:

```js
let encoding = 'base64';              // poprawna domyślna wartość
if (att) encoding = att.encoding;     // ...nadpisana przez undefined
```

czyli traciło domyślne `base64` i **nie odkodowywało** części. Parser dostawał
`QkVHSU46VkNBTEVOREFS…` zamiast `BEGIN:VCALENDAR…` i odrzucał zaproszenie.
Ten sam defekt psuł pobieranie pliku `.ics` i przekazywanie go dalej.

## 11. Naprawa

- część kalendarza niesie teraz zadeklarowany transfer encoding, a
  `attachmentTransferEncoding()` rozstrzyga go tak, że **brak wartości nie
  nadpisuje domyślnej** (to była właściwa przyczyna);
- gdy zapisane `raw_ical` jest nieobecne **lub nieparsowalne**, czytnik schodzi
  do surowej części MIME — wiadomość sprzed zapisu zaproszenia nadal da się
  otworzyć i zaimportować;
- nieosiągalna skrzynka to „brak zaproszenia”, a nie 500 z niejasnym błędem.

Testy: `imapManager.test.js` (odkodowanie realnego base64 ICS + zachowanie
domyślnego kodowania) oraz nowy `calendar.invitationRead.test.js` (5 przypadków:
odczyt z załącznika, fallback z nieparsowalnego `raw_ical`, brak sięgania do
skrzynki gdy zapis jest dobry, niedostępna skrzynka, import do kalendarza).
Sprawdzone także odwrotnie: po cofnięciu naprawy oba testy `imapManager` padają.

## 12. Domyślna skrzynka do zaproszeń

`Ustawienia → Kalendarz → Domyślna skrzynka nadawcy zaproszeń`: lista kont
zdolnych do wysyłki (`enabled` + `smtp_host`), zapisywana jako preferencja
użytkownika. Nowe wydarzenie wybiera ją wstępnie; wartość wskazująca konto, które
nie może już wysyłać, jest ignorowana.

## 13. Spójna prezentacja opcji

Jeden wzorzec (nazwa opcji + krótki opis pod spodem), jak w
`Ustawienia → Wygląd → Układ → Lista wiadomości`:

- `SettingsChoices` przyjmuje opis grupy i opis dla każdej wartości — używają go
  kalendarz (pierwszy dzień tygodnia) i pozycja panelu na telefonie (góra/dół);
- nowy `SettingsSwitchRow` (nazwa + stały opis + przełącznik) obsługuje
  **Grupowanie wiadomości**, **Czytnik wiadomości** i **Favikony nadawcy** —
  wcześniej te dwa pierwsze miały inną typografię i podmieniały opis między
  wariantem „on/off”, co odbiegało od reszty ustawień;
- opisy dodane także do dni roboczych i godzin pracy;
- martwe klucze `threadingOn/Off`, `threadingOnDesc/OffDesc`,
  `readerOnDesc/OffDesc` usunięte z 9 języków, w ich miejsce stałe opisy.

## 14. Testy i obrazy (runda 3)

- backend: `npx vitest run` — 1696 przechodzi, 13 pominiętych;
- frontend: `npm test` — 2180 przechodzi; `npm run build` — OK;
- `eslint --max-warnings 0` — czysto;
- obrazy `:dev` z commita `41f582c` (amd64+arm64), sprawdzone po pobraniu z GHCR:
  backend zawiera `attachmentTransferEncoding` i `fetchInvitationAttachment`,
  frontend — `defaultInviteAccount` i style `settings-switch-row`.

---

# Runda 4 — podgląd wydarzenia, link do maila, nagłówki i panele na telefonie

Wszystkie pomiary wykonane Playwrightem na zbudowanej aplikacji (390×844 i
1440×900), nie „na oko”.

## 15. Dlaczego opis „nadal nie renderował się jak treść maila”

Zmierzone: mail i kalendarz renderowały opis **identycznie** (ta sama ramka, ten
sam `MessageBodyRenderer`, ten sam wynik 300 px dla krótkiej treści, a dla
bogatego HTML `b=1, li=2, a=1, table=1`). Różnica była w tym, **który widok się
otwierał**:

```js
if (!event.read_only && event.source === 'local') openEdit(event);  // ← pomijał podgląd
else setPreview(event);
```

Wydarzenia lokalne — czyli te, z którymi pracuje użytkownik — trafiały **prosto do
edytora**, więc opis nigdy nie był renderowany jak treść wiadomości. To była
właściwa przyczyna.

**Naprawa:** `openEvent` zawsze otwiera podgląd (mail-like), a edycja jest o jedno
dotknięcie (`Edytuj` w stopce podglądu, tylko dla wydarzeń edytowalnych).

## 16. Link do pierwotnej wiadomości

- migracja `0081_calendar_event_source_message.sql` — `calendar_events.source_message_id`
  z `ON DELETE SET NULL` + indeks częściowy;
- import zaproszenia z maila zapisuje to id (także przy `ON CONFLICT`);
- `GET /events` zwraca `source_message_id` **tylko gdy wiadomość należy do konta
  tego użytkownika** (`LEFT JOIN messages` + `LEFT JOIN email_accounts ... AND
  sa.user_id = e.user_id`), razem z `source_folder` i `source_account_id`;
- podgląd pokazuje „Otwórz pierwotną wiadomość”; kliknięcie pobiera wiadomość po
  id i publikuje ją jako jedną rozmowę (`openDeepLinkMessage`), bo wiadomość może
  być w innym koncie/folderze i nie być na załadowanej liście (samo
  `setSelectedMessage` na nieznanym id otwiera pusty czytnik).

Sprawdzone na żywym PostgreSQL: własna wiadomość linkuje się z folderem i kontem,
**wiadomość innego użytkownika nigdy nie jest linkowana**, a usunięcie maila
zostawia wydarzenie i usuwa link.

## 17. Podgląd i edycja pełnoekranowe na telefonie

Nowy modyfikator `.ui-fullscreen` (`ui.css`, w media query ≤767 px): overlay bez
paddingu, panel 100 % szerokości i `100dvh`, bez zaokrągleń, z poszanowaniem
safe-area. Używają go podgląd wydarzenia i edytor. Zmierzone: podgląd na 390×844
ma dokładnie 390×844 px i `y=0`.

## 18. Dwa wiersze nagłówkowe na telefonie

Zmierzone w czytniku: `mobile-topbar` (wys. 53 px, hamburger + „Inboxora”) **nad**
własnym wierszem czytnika („Wstecz | temat”). Gdy czytnik jest otwarty,
`moduleActive` było `false`, więc pasek pokazywał bezużyteczną nazwę aplikacji.
Naprawa: czytnik (i widok kontaktu) przekazuje swoje akcje do wspólnego paska przez
istniejący `MobileModuleHeader`, a własny drugi wiersz znika. Podwójny safe-area
padding (`calc(var(--sat) + 10px)`) usunięty — pasek już go obsługuje.

## 19. Spójność „Agenda dnia” i „Panel kalendarzy”

Zmierzone przed naprawą: w obu panelach **podwójny padding** (body `12px 16px 16px`
+ rail `14px`), **zdublowany tytuł** (nagłówek arkusza i `h1`/`h2` w treści),
trzecie „Nowe wydarzenie” w arkuszu, a dni mini-miesiąca miały **22 px** wysokości.
Reguła `.ui-dialog.ui-sheet .ui-dialog-body` ma wyższą specyficzność, więc samo
`.calendar-day-dialog .ui-dialog-body { padding: 0 }` nie działało — stąd brak
efektu pierwszego podejścia.

Naprawa: jedna warstwa paddingu, jeden tytuł (nagłówek arkusza), brak trzeciego
„Nowe wydarzenie”, wspólna skala typograficzna i **dotykowe cele 40×40**
(rozmiar mini-miesiąca przeniesiony z inline do CSS, bo inline wygrywał z regułą).
Zmierzone po naprawie: tytuły `["Agenda dnia"]`, padding `0px`, wiersz agendy
55 px, przycisk dnia 40×40.

## 20. Testy (runda 4)

- backend: `npx vitest run` — 1698 przechodzi, 13 pominiętych;
- frontend: `npm test` — bez regresji; `npm run build` — OK; `eslint` — czysto;
- nowe testy: `calendar.events.test.js` (izolacja źródłowej wiadomości),
  `calendar.invitationRead.test.js` (zapis `source_message_id`),
  `CalendarEventPreview.test.js` (kontrakt podglądu), `e2e/calendar-sheets.spec.js`
  (spójność arkuszy); zaktualizowany `e2e/calendar-invitations.spec.js` do nowego
  przepływu podgląd → edycja;
- Playwright: `calendar*.spec.js` — 89 przechodzi, 8 pominiętych.

---

# Runda 5 — pamięć widoku, szerokości paneli i menu wydarzenia

## 21. Szerokości paneli nigdy nie były zapisywane (realny błąd)

Zmierzone: przeciągnięcie uchwytu zmieniało szerokość na żywo (296 → 376 px), ale
`localStorage.mailflow_agenda_width` pozostawało `null`, a po przeładowaniu wracało
296 px. Przyczyna w `panelWidth.js`:

```js
onEnd?.(persist(read()));   // brak onEnd ⇒ persist() NIGDY się nie wykonuje
```

Opcjonalne wywołanie zwiera **argumenty**, a `onEnd` nie przekazuje żaden
wywołujący — więc `persist()` nie działało. To ta sama pułapka, przed którą kod
ostrzega obok przy `onResize?.(apply(...))`, tylko o poziom niżej. Naprawa:
najpierw zapis, potem powiadomienie. Nowy test (`panelLayout.test.js`) sprawdza
zapis po `mouseup` bez `onEnd` i **zawodzi na poprzedniej implementacji** —
poprzedni test weryfikował tylko, że przeciągnięcie stosuje szerokość, dlatego
błąd przeszedł.

## 22. Widok kalendarza nie był pamiętany

`{showCalendar && <CalendarPage/>}` — strona jest **odmontowywana** przy powrocie
do skrzynki, więc `useState('month')` gubiło wybór zarówno w sesji, jak i po
przeładowaniu. Widok zapisywany jest teraz per urządzenie
(`mailflow_calendar_view`), obok szerokości paneli: ile kalendarza mieści się na
ekranie, zależy od ekranu, więc telefon i desktop mogą mieć różne widoki.
Nieznana lub nieczytelna wartość wraca do miesiąca zamiast rzucać wyjątkiem.
Weryfikacja: `calendar-persistence.spec.js` — widok przeżywa wyjście z kalendarza
i reload na desktopie i telefonie, a szerokość panelu wraca po odświeżeniu.

## 23. Menu z trzema kropkami usunięte

Przycisk `⋮` przy wydarzeniu konkurował o szerokość z tytułem, a dotknięcie
wydarzenia i tak otwiera podgląd z edycją i usunięciem (dla edytowalnych) lub bez
nich (dla tylko-do-odczytu). Usunięte w obu miejscach (siatka czasu i pasek
całodniowy) wraz z nieużywanym stylem. Menu kontekstowe zostaje: prawy przycisk,
`Shift+F10` i gest long-press — testy sprawdzają teraz gest zamiast przycisku.

Snapshoty mobilne tygodnia odświeżone: kafelek wydarzenia był `flex: 1` obok
przycisku 44 px, więc po jego usunięciu każdy kafelek się poszerza (zmiana obszaru
siatki to oczekiwany reflow, nie przypadkowy diff).

## 24. Testy (runda 5)

- frontend: `npm test` — 2192 przechodzi, 0 padniętych; `eslint src` czysto;
- backend: `npx vitest run` — 1698 przechodzi (bez zmian w tej rundzie; jeden
  test czasu padł raz pod obciążeniem równoległego Playwrighta i przechodzi
  w izolacji oraz w pełnym przebiegu);
- Playwright: 151 przechodzi (kalendarz, zaproszenia, arkusze, trwałość,
  mobilna nawigacja, v3-interface, panel-width, responsive-parity).

Uwaga: lint `e2e/` ma 12 zastanych problemów (poza zakresem CI, który lintuje
`src`); moje pliki e2e są czyste.




