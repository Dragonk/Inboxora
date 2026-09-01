# Inboxora — kalendarze, mobilna nawigacja, branding i Wiki

## Cel
Dostarczyć na `dev` kompletny, spójny z motywami kalendarz: preferencje tygodnia i mobilnej nawigacji, źródła zewnętrzne pull-only, read-only kalendarz dat kontaktów, selektor widoczności i mini-miesiąc, poprawione favicon/logo oraz zwięzły README z Wiki jako kanoniczną bazą wiedzy.

## Założenia i granice
- Desktop zachowuje górny przycisk „Nowe wydarzenie”; mobilnie pozostaje FAB.
- Własne źródła pozostają `caldav`/`ical_url`, pull-only/read-only. Wykorzystujemy istniejące endpointy `/api/calendar/sources`; nie zapisujemy ani nie zwracamy haseł.
- Kalendarz kontaktów jest wirtualnym źródłem `contacts-birthdays`, tylko do odczytu. Dane: `birthday` i `anniversary` (typ DATE), emitowane do istniejącej odpowiedzi wydarzeń tylko w żądanym zakresie.
- Widoczność kalendarzy i ustawienia widoku są per-user w `users.preferences`, z walidacją backendu. Ukrycie nie usuwa źródła ani wydarzeń.
- Pierwszy dzień tygodnia: niedziela lub poniedziałek. Ustawienie wpływa na zakres tygodnia i wyrównanie widoku miesiąca.
- Mobilna nawigacja `top|bottom` jest globalną preferencją, domyślnie `top`; dolna pozycja respektuje safe-area i nie koliduje z FAB.
- Wszystkie teksty są w 9 locale. Komponenty używają tokenów `var(--…)`, bez stałych kolorów motywu.

## Pionowe etapy TDD
1. **Preferencje i geometria tygodnia**
   - RED: testy `calendarView` dla poniedziałku/niedzieli oraz test API preferencji dla ograniczonych wartości.
   - GREEN: `calendarWeekStartsOn`, `mobileNavigationPosition`, `visibleCalendarIds` w store/backendzie; UI preferencji kalendarza.
2. **Źródła i panel kalendarzy**
   - RED: backend testy listy/dodawania źródeł bez ujawniania hasła; test/UI kontrakt mini-miesiąca i przełączników.
   - GREEN: rozszerzyć klienta API; desktopowy sidebar kalendarza, mobilny drawer na żądanie; dodawanie, synchronizacja, usuwanie źródeł; mini-miesiąc wybiera anchor dla month/week/work-week.
3. **Daty kontaktów i kalendarz kontaktów**
   - RED: testy generacji vCard BDAY/ANNIVERSARY, walidacji i syntetycznych zdarzeń bez przekraczania zakresu.
   - GREEN: migracja, API kontaktu, UI danych, union w `/events`, wirtualny calendar list item.
4. **Mobilne top/bottom oraz branding**
   - RED: kontrakty DOM dla pozycji mobilnej nawigacji i assetów favicon.
   - GREEN: mobilne kontrolki kalendarza i listy reagują na pozycję; FAB ma offset od dolnej nawigacji; logo bez wymuszonego tła i aktywa favicon w wersjonowanych ścieżkach oraz SW.
5. **Dokumentacja**
   - README: zwięzły opis, quick start, licencja/upstream attribution i łącze do Wiki.
   - Wiki: Home, Installation, Configuration, Calendar, Contacts and DAV, External calendars, Mobile navigation, Security, Troubleshooting, Development/Contributing. Skrypty synchronizacji lub repozytorium wiki nie publikują bez weryfikacji GitHub.

## Bramki
- Przed publikacją: jednostkowe backend/frontend, lint, build, pełna macierz lokalnego Playwright bez Dockera, `git diff --check`, spec review i quality review.
- Następnie commit z `Assisted-by: Hermes Agent`, push wyłącznie na `dev`, potwierdzenie CI/publish oraz publicznych manifestów `:dev`.
- `main`, tag i `latest` pozostają poza zakresem do ręcznej akceptacji użytkownika.
