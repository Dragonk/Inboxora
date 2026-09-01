# Inboxora: mobilny kalendarz, kontakty i nawigacja — plan wydania dev

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Dostarczyć do `dev` kompletną, responsywną obsługę kalendarza i kontaktów: bez regresji mobilnej nawigacji, z czytelnym kalendarzem, konfigurowalnymi preferencjami, źródłami zewnętrznymi oraz kalendarzem urodzin kontaktów.

**Architecture:** Zachować obecny React/Vite + Zustand + Express/PostgreSQL. Preferencje per-user zapisać w istniejącym `users.preferences` i synchronizować przez `PATCH /api/auth/preferences`. Kalendarze zewnętrzne pozostają pull-only/read-only; kalendarz urodzin jest wirtualnym read-only źródłem wyprowadzanym z dat kontaktów i nie może być miejscem zapisu wydarzeń.

**Tech stack:** React, Zustand, i18next (9 locale), Express, PostgreSQL, CardDAV/CalDAV, Vitest/node:test, Playwright.

---

## Zakres i kryteria akceptacji

1. Na telefonie nie ma ikony/przycisku Kontaktów w górnej belce listy poczty; Kontakty nadal są osiągalne z menu bocznego.
2. Mobilny systemowy Back z otwartego maila zawsze wraca do listy i nie opuszcza PWA/aplikacji.
3. Mobilny Kalendarz ma Back, pływający przycisk „Nowe wydarzenie” w prawym dolnym rogu oraz dialog, który nie przekracza viewportu i ma dostępne akcje.
4. Widok tygodnia/work-week ma oś godzin, subtelną siatkę, czasowo pozycjonowane wydarzenia oraz czytelne zachowanie na telefonie (przewijanie poziome zamiast ścisku).
5. Preferencje Kalendarza umożliwiają: dzień początku tygodnia, położenie mobilnej nawigacji/paska oraz widoczność każdego kalendarza.
6. UI umożliwia dodanie, wyświetlenie i usunięcie zewnętrznego źródła ICS/CalDAV wykorzystując istniejące pull-only API; sekrety źródeł nie są nigdy zwracane ani logowane.
7. Kontakty wspierają najczęściej synchronizowane pola Android/CardDAV: urodziny, rocznicę i inne nazwane daty; dane przechodzą import/export vCard/CardDAV.
8. „Urodziny kontaktów” są widoczne jako read-only kalendarz, można je włączyć/wyłączyć w preferencjach, a wpisy są generowane z kontaktów bez możliwości edycji jako zwykłe wydarzenia.
9. Edycja profilu na telefonie renderuje się nad zamkniętym drawerem i jest widoczna bez ponownego otwierania menu.
10. Wszystkie nowe etykiety są obecne w 9 locale; lokalne testy, lint, build i kompletna mockowana macierz Playwright przechodzą bez Dockera.

## Zadania

### Task 1: Stabilizacja mobilnego Back i górnej belki poczty

**Files:**
- Modify: `frontend/src/components/MailApp.jsx:418-474, 660-734`
- Modify: `frontend/src/components/MessageList.jsx:2610-2628`
- Test: `frontend/e2e/mobile-reader-navigation.spec.js` (new)

1. Napisać Playwright reprodukujący otwarcie wiadomości na obu mobilnych viewportach, `page.goBack()`/Back i oczekiwanie na listę bez zamknięcia dokumentu.
2. Potwierdzić RED dla obecnego niestabilnego przebiegu lub ograniczyć test do konkretnego rozjazdu historii.
3. Ujednolicić stan historii: pojedynczy wpis per przejście list→reader, obsługa `popstate` zawsze konsumuje reader i nie re-armuje historii przed zwolnieniem stanu.
4. Ukryć mobilny przycisk Kontaktów z `MessageList`, pozostawiając `calendar-nav-mobile`/`contacts-nav-mobile` w drawerze.
5. Przejść targeted E2E i testy istniejącej nawigacji.

### Task 2: Mobilny Kalendarz — FAB i dialog mieszczący się w ekranie

**Files:**
- Modify: `frontend/src/components/CalendarPage.jsx:20-121`
- Modify: `frontend/e2e/calendar-mobile-navigation.spec.js`
- Test: `frontend/src/components/CalendarPage.test.js`

1. Utrzymać istniejący czerwony test Playwright na `calendar-mobile-new-event` i viewport dialogu.
2. Wyrenderować desktopowy przycisk tekstowy wyłącznie poza mobile; na mobile dodać 44px+ FAB w prawym dolnym rogu z bezpiecznym marginesem.
3. Nadać dialogowi `box-sizing: border-box`, ograniczenie szerokości do viewportu oraz jednokolumnowy układ pól na mobile.
4. Dodać stabilne `data-testid` dla FAB i wewnętrznej karty dialogu.
5. Zweryfikować targetowany Playwright na 390×844 i Pixel 7.

### Task 3: Widoki tygodnia i tygodnia roboczego z osią czasu

**Files:**
- Modify: `frontend/src/components/CalendarPage.jsx`
- Modify/Create: `frontend/src/components/calendarView.js`, `frontend/src/components/calendarView.test.js`
- Modify: `frontend/src/components/CalendarPage.test.js`

1. Napisać testy wyliczające pionową pozycję i wysokość wydarzenia z czasu startu/końca, z przypadkiem nakładania.
2. Potwierdzić RED na bieżącym renderowaniu listowym.
3. Utworzyć grid time-based: zamrożona kolumna godzin, kolumny dni, siatka półgodzinna/godzinna oraz absolutnie pozycjonowane eventy.
4. Ustawić poziome przewijanie na mobile przy zachowaniu minimalnych szerokości dni; nie ściskać siedmiu dni do szerokości telefonu.
5. Przetestować month/week/work-week na desktop i mobile oraz zachować double-click/create i edit.

### Task 4: Preferencje Kalendarza i mobilnej nawigacji

**Files:**
- Modify: `backend/src/routes/auth.js` (walidacja preference keys)
- Modify: `frontend/src/store/index.js:960+`
- Create: `frontend/src/components/CalendarSettings.jsx`
- Modify: `frontend/src/components/Sidebar.jsx` lub istniejący host ustawień
- Modify: `frontend/src/components/CalendarPage.jsx`
- Test: odpowiednie `*.test.js`, backend `auth` tests

1. Zdefiniować wersjonowane preference keys: `calendarWeekStartsOn`, `calendarVisibleIds`, `mobileNavigationPosition`.
2. Napisać RED backend validation dla dozwolonych wartości i test store dla round-trip.
3. Dodać ustawienia w widoku Ustawienia: początek tygodnia, góra/dół mobilnego paska, lista widoczności kalendarzy.
4. Wyświetlać ustawienia w Kalendarzu i wykorzystać je do zakresów/kolumn oraz renderowania mobilnego chrome.
5. Dopisać 9 locale i testy E2E zapisu/odtworzenia.

### Task 5: Zarządzanie zewnętrznymi źródłami kalendarzy

**Files:**
- Modify: `frontend/src/utils/api.js`
- Modify/Create: `frontend/src/components/CalendarSettings.jsx`
- Modify: `backend/src/routes/calendar.js`, `backend/src/routes/calendar.test.js` tylko jeśli brakuje bezpiecznej odpowiedzi/validacji
- Test: frontend/API tests

1. Zmapować istniejące `/import-sources` i ich kontrakt bez odczytywania przechowywanych haseł.
2. Napisać RED dla list/create/delete źródła z UI i maskowania wrażliwych pól.
3. Dodać UI źródeł: ICS URL oraz CalDAV URL/username/app password, nazwa/kolor/interwał; nie pokazywać password po zapisie.
4. Zachować pull-only/read-only i obsłużyć błędy połączenia w UI.
5. Zweryfikować testy mockowane, bez prawdziwych serwerów i credentiali.

### Task 6: Daty kontaktów i read-only kalendarz Urodzin

**Files:**
- Create: `backend/migrations/0068_contact_dates_and_birthdays.sql`
- Modify: `backend/src/routes/contacts.js`, `backend/src/routes/contacts.test.js`
- Modify: `backend/src/services/vcard.js` i CardDAV tests/usages
- Modify: `backend/src/routes/calendar.js`, `backend/src/routes/calendar.test.js`
- Modify: `frontend/src/components/ContactsPage.jsx`, `frontend/src/components/CalendarPage.jsx`, `frontend/src/utils/api.js`
- Test: contact, CardDAV, calendar and Playwright tests

1. Ustalić minimalny model: `birthday`, `anniversary`, JSONB `named_dates` w formacie bez strefy czasowej.
2. Dodać migrację z constraintami i testy RED create/update/list contact data.
3. Zaktualizować serializację/parsing vCard dla `BDAY`, `ANNIVERSARY` i udokumentowanych custom dates, bez usuwania nieznanych atrybutów.
4. Rozszerzyć formularz kontaktu o daty oraz lokalizacje.
5. Wprowadzić wirtualny kalendarz „Urodziny kontaktów”: read-only, deterministyczny, z całodniowymi rocznymi zdarzeniami, niedostępny dla create/update/delete.
6. Połączyć go z `calendarVisibleIds` i testami zakazu zapisu.

### Task 7: Mobilna edycja profilu

**Files:**
- Modify: `frontend/src/components/Sidebar.jsx:353,1675-1692,1971`
- Modify: `frontend/src/components/ProfileModal.jsx`
- Test: `frontend/e2e/profile-mobile.spec.js` (new)

1. Napisać RED reprodukujący drawer → Edytuj profil → widoczny dialog bez otwierania draweru.
2. Przenieść ownership modalu nad mobile drawer albo renderować go przez portal/warstwę okienną o większym z-index.
3. Zapewnić focus trap, Back/Escape i powrót do zamkniętego draweru.
4. Zweryfikować oba portretowe viewporty.

### Task 8: Integracja i wydanie dev

1. Dokończyć testy jednostkowe backendu i frontendu, `npm run lint`, `npm run build`.
2. Uruchomić pełne `npm run test:e2e` lokalnie w trybie mocked bez Dockera; jasno raportować environment-gated skipy.
3. Uruchomić `git diff --check`, niezależny review spec/quality oraz finalną integracyjną recenzję.
4. Dopiero po sukcesie: jeden commit na `dev` z trailerem `Assisted-by: Hermes Agent`, push, weryfikacja dokładnego SHA CI oraz publikacji GHCR `:dev`.
5. Nie merge’ować do `main`, nie tagować release i nie dotykać produkcji.

## Ryzyka / ograniczenia

- Nie podłączamy realnych CalDAV/SMTP/OIDC ani nie używamy realnych credentiali podczas testów.
- vCard Android bywa różny zależnie od dostawcy: testy będą obejmować standardowe `BDAY`, `ANNIVERSARY` i zachowanie nieznanych pól.
- Kalendarz urodzin będzie logicznym read-only źródłem; nie będzie zapisywany jako duplikaty `calendar_events`.
- Wymaganie „pozostałe ustawienia” zostało ujęte tylko dla jawnie wskazanych dziś opcji; po zakończeniu widocznych ustawień wymagany jest osobny przegląd, jeśli chodziło o dodatkowe nieudokumentowane preferencje.
