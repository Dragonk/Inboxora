# Wątkowanie Gmaila, liczniki i push — 2026-09-11

## Przyczyny i poprawki

1. Zwykła lista wątkowana używa `messages.thread_key`, wyliczanego ze starszego `thread_id`. Silnik rozmów zapisywał X-GM-THRID, lecz nie przekazywał go do tej ścieżki listowania. Zapis Gmaila aktualizuje teraz wspólny klucz listy, rozwinięcia i operacji zbiorczych. Migracja 0079 naprawia istniejące wiadomości z zapisanym identyfikatorem Gmaila. Identyfikatory 64-bit pozostają tekstem; jednakowy temat bez jednakowego X-GM-THRID nie łączy wiadomości. Naprawiono też rozpoznanie `imap.googlemail.com` i odczyt utrwalonych identyfikatorów przy ponownym przetwarzaniu.
2. Sygnał IMAP EXISTS podczas aktywnej synchronizacji był pomijany. Teraz zapisuje oczekującą synchronizację, wykonywaną po zwolnieniu blokady konta.
3. Nowe wiadomości czekały na skan zmian flag starszej poczty, zanim aplikacja wysłała WebSocket i push. Powiadomienie o nowych UID wychodzi wcześniej, po zastosowaniu reguł i blokad. Skan starych flag nie blokuje tej ścieżki.
4. Web Push wysyła z priorytetem `high`, ogranicza czas oczekiwania na połączenie i ponawia przejściowe błędy sieci/429/5xx do trzech prób. Wygasłe subskrypcje nadal są usuwane; błąd jednego urządzenia nie blokuje pozostałych.
5. Service worker pokazuje powiadomienie niezależnie od dostępności otwartych kart. Informuje działającą aplikację o zmianie poczty. Obsługuje odnowienie subskrypcji bez otwierania ustawień; normalne uruchomienie aplikacji ponownie zapisuje istniejącą subskrypcję na backendzie.
6. Czytnik rozmów zmienia od razu licznik konta i folderu INBOX po odczytaniu konkretnej kopii wiadomości, z wycofaniem zmiany przy błędzie zapisu. Wspólne odświeżanie liczników odrzuca spóźnione odpowiedzi, które nadpisywały nowszy wynik albo optymistyczny odczyt.
7. Powrót do aplikacji, odzyskanie sieci i push odświeżają listę oraz liczniki. Po wybudzeniu nie trzeba czekać na zwykły heartbeat martwego WebSocketu. Rezerwowe odświeżanie liczników widocznej karty skrócono z 5 minut do 1 minuty; zdarzenia nadal aktualizują je na bieżąco.

## Dowody

- Test rzeczywistego PostgreSQL: dwa niezależne maile z tym samym X-GM-THRID są jedną pozycją listy z dwoma dziećmi; identyczny temat z innym X-GM-THRID jest osobną pozycją.
- Test IMAP: powiadomienie nowej poczty poprzedza skan starszych flag; EXISTS podczas pracy prowadzi do drugiej synchronizacji.
- Testy push: priorytet, ponowienia, wygasłe urządzenia, wyświetlenie bez działającej karty, odnowienie subskrypcji.
- Testy przeglądarkowe: licznik zmniejsza się przed zakończeniem sztucznie opóźnionego zapisu; sygnał service workera odświeża listę bez nawigacji.
- Testy kolejności liczników: starsza odpowiedź nie zastępuje nowszej ani lokalnego odczytu.

Gmail udostępnia X-GM-THRID właśnie do odtworzenia grupowania swojej aplikacji: [oficjalna dokumentacja Google](https://developers.google.com/workspace/gmail/imap/imap-extensions#access_to_the_gmail_thread_id_x-gm-thrid). Pozostałe serwery nadal korzystają z dostępnych nagłówków i własnego silnika rozmów Inboxory.

Testy powiadomień używają syntetycznych danych i atrap dostawcy push. Nie wysyłano wiadomości ani powiadomień na prywatne konta i urządzenia użytkownika. Opóźnienie po stronie systemu Android lub zewnętrznej usługi push wymaga pomiaru na fizycznym urządzeniu; nie jest mierzone przez testy Chromium.
