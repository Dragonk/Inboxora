# Przegląd DAV, opisów wydarzeń i zaproszeń — 2026-09-11

Wprowadzone poprawki:

- CalDAV oraz import ICS zapisują opis, lokalizację, URL, organizatora i uczestników. Odczyt istniejących wydarzeń odzyskuje brakujące pola z zachowanego źródła ICS; obsługuje też HTML w `X-ALT-DESC` bez wykonywania HTML.
- Widok kalendarza rozwija RRULE/RDATE, pomija EXDATE i uwzględnia wyjątki RECURRENCE-ID, odwołane wystąpienia oraz strefy czasowe Exchange. Edycja pojedynczego wystąpienia zachowuje serię, alarmy i dodatkowe właściwości zasobu.
- Wiadomość z rozpoznanym zaproszeniem lub załącznikiem ICS pokazuje kartę z wyborem kalendarza i akcją dodania. Ponowne dodanie tego samego zaproszenia nie tworzy duplikatu; nowsza sekwencja aktualizuje import. Dodanie nie wysyła odpowiedzi RSVP.
- CardDAV zachowuje dodatkowe pola kontaktu: stanowisko, rolę, pseudonim, adresy, strony WWW, komunikatory i kategorie. Poprawiono wybór preferowanego emaila, wartości ze znakami specjalnymi oraz urodziny bez roku (`--MM-DD`). Te daty można odczytać i zachować przy edycji; kalendarz wyświetla je w odpowiednim roku.
- Nazwa pliku DAV jest niezależna od UID wewnątrz zasobu. GET, PUT, DELETE, listowanie i synchronizacja zachowują nazwę wybraną przez klienta. Warunki ETag są sprawdzane również w samym zapisie SQL.
- CardDAV ma trwały dziennik synchronizacji, w tym usunięcia i przenoszenie kontaktów między książkami przez REST. Nieaktualne tokeny wymagają pełnej synchronizacji. Multiget pobiera tylko wskazane zasoby i zgłasza brakujące przez 404.
- Uszkodzone odpowiedzi DAV nie są traktowane jako usunięcie kolekcji. Poprawna pusta kolekcja usuwa poprzednią projekcję. Błąd konfiguracji połączenia nie pozostawia zablokowanej synchronizacji CardDAV.

Migracje: `0077_dav_resource_filenames.sql`, `0078_carddav_sync_changes.sql`. Dotychczasowe URI oparte na UID nadal działają.

Weryfikacja tego etapu: 1589 testów backendu, 2119 testów frontendu; dodatkowo 2 testy rzeczywistych endpointów HTTP DAV na izolowanym PostgreSQL (tworzenie, odczyt, zmiana, usunięcie, rich fields, ETag, równoczesne zapisy i tombstone). Lint obu części przechodzi. Testy przeglądarkowe i końcowa publikacja są weryfikowane dla końcowego SHA całego zadania.

## MailFlow upstream

Sprawdzono upstream do `60a4779257d45b09f270f42346ceb21f8401a2b0`:

- [31aeaeb — odporność na awarie zależności](https://github.com/maathimself/mailflow/commit/31aeaeb9b5320a494487fc0fbc68c92d1c5b6a50): odtworzono obsługę awarii PostgreSQL/Redis/WebSocket, zabezpieczenie przed podwójną wysyłką i ponowne rozwiązywanie adresu backendu przez nginx, zachowując ścieżki DAV Inboxory.
- [57dbbc0 — usunięte foldery](https://github.com/maathimself/mailflow/commit/57dbbc09c5b5b7f9b904fffd1b1900b063f03d8f): odtworzono usuwanie osieroconego cache wiadomości po usunięciu folderu na serwerze.
- [60a4779 — usunięte konto](https://github.com/maathimself/mailflow/commit/60a4779257d45b09f270f42346ceb21f8401a2b0): odtworzono czyszczenie wyboru usuniętego konta, folderów i czytnika.
- Zmian liczników z `50d3cb7` nie przeniesiono hurtowo: Inboxora ma własny silnik rozmów i model kopii wiadomości. Zmiany zależności porównano z aktualnymi lockfile; audyt zależności produkcyjnych nie zgłasza high/critical (pozostają ostrzeżenia moderate).

Zakres potwierdzenia: testy syntetyczne, izolowana baza, lokalna przeglądarka. Nie jest to potwierdzenie działania na prywatnym serwerze służbowym ani dostarczenia push na fizyczne urządzenie użytkownika. Subskrypcja ICS pozostaje odczytowa; importy zewnętrznych kolekcji DAV nadal korzystają z istniejącego modelu synchronizacji do Inboxory. Lokalne kolekcje Inboxory obsługują zapis DAV.
