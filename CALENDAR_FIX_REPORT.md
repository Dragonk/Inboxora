# Inboxora — raport naprawy kalendarza (DSH)

Audytowany SHA: `8273e3b34ff52e84c08a17854735d46b61d36d11` (gałąź `dev`).
HEAD w chwili pracy: **ten sam** SHA. Gałąź robocza: `dev` (bez zmian cudzych commitów, `main` nietknięty).

Zakres: cała praca wykonana na kopii roboczej wyprowadzonej z audytowanego `dev`. Nie zmieniano `main`, danych produkcyjnych, ani nie usunięto żadnego wydarzenia/serii.

---

## 1. Potwierdzone przyczyny

### B. Przesunięte wystąpienia — potwierdzone odtworzeniem (przyczyna realna)

`event.iterator(windowStart)` **nie jest neutralnym przewinięciem** – ustawia `dtstart` rozwijania, od którego `rule.iterator(this.dtstart)` inicjalizuje regułę. Pomiar na kodzie z audytowanego SHA:

| Przypadek | Wynik na `8273e3b` | Poprawny wynik |
|---|---|---|
| DAILY 09:00, seria od 2026-01-05, okno od 2026-09-01 | `00:00`, `00:00` (godzina i TZID zgubione) | `09:00` |
| ALL-DAY DAILY | `all_day=false`, `recurrence_id` DATE-TIME | `all_day=true`, DATE |
| WEEKLY **INTERVAL=2** | `2026-09-01` (faza zresetowana) | `2026-09-14` |
| MONTHLY DTSTART 31.01 | 1. dzień miesiąca | 31. |
| Wystąpienie przecinające lewą granicę | pominięte | obecne |

To nie była tylko kwestia wydajności — to była **utrata i przesunięcie wydarzeń**. Audyt miał rację.

### A. Synchroniczne rozwijanie na pętli zdarzeń — potwierdzone pomiarem

`projectCalendarResource()` było wołane synchronicznie w handlerze HTTP, a `flatMap` nie izolował zasobów. Zmierzona bezpośrednio blokada pętli zdarzeń (timer 10 ms): przy rozwijaniu MINUTELY × 4 od 2000 r. do okna 2026 timer **nie odpalił się ani raz** (`samples=0`) — czyli wątek obsługi API był zablokowany na cały czas ekspansji. To dokładnie opóźnia pocztę i kontakty.

### C. Alokacje `Intl.DateTimeFormat` — potwierdzone pomiarem

`timeZoneParts()` tworzył nowy formatter przy każdym wywołaniu. Mikrotest 6000 konwersji × 4 wywołania: **2007 ms / 24000 konstrukcji** vs **118 ms** przy ponownym użyciu.

### D. Brak anulowania żądań — potwierdzone w kodzie

`load()` w `CalendarPage.jsx` nie miało `AbortController` ani cleanupu; `loadGeneration` chronił tylko przed nadpisaniem stanu, nie przerywał pracy backendu.

### E. Koszt układu widoku — potwierdzone pomiarem

`layoutTimedEvents()` miało zagnieżdżone skany (koszt sześcienny). 1000 nakładających się wydarzeń: ~271 ms w mikroteście audytu.

### Ustalenie negatywne (ważne dla rzetelności)

Zysk wydajnościowy z audytu (`145 ms` → szybciej) był **okupiony błędnymi danymi**. To nie była optymalizacja do zachowania, tylko regresję do cofnięcia. Pomiar na oryginalnym SHA: UTC 145 ms / TZID 156 ms, ale z błędnymi wystąpieniami jak wyżej.

---

## 2. Zmienione pliki

### Backend
- `backend/src/utils/calendarRecurrence.js` — rozwijanie **zawsze od oryginalnego DTSTART**; `projectCalendarResourceWithStatus()` z budżetem, `deadline`, `shouldAbort`, `fullScan`; konserwatywny prefiltr zegara ściennego; izolacja pojedynczego uszkodzonego wyjątku; reużycie już sparsowanego roota.
- `backend/src/utils/ical.js` — cache `Intl.DateTimeFormat` (LRU 64, także negatywny); cache definicji VTIMEZONE **w kontekście zasobu**; `calendarZoneResolver(raw, parsedRoot)`.
- `backend/src/services/calendarProjectionPool.js` **(nowy)** — ograniczona pula `worker_threads`, kolejka z limitem, twardy timeout na zadanie, degradacja do pracy inline, cache projekcji (etag + zakres + budżet + wersja algorytmu), koalescencja identycznych obliczeń, `workerExecArgv()`.
- `backend/src/services/calendarProjectionWorker.js` **(nowy)** — jedno zadanie = jeden zasób.
- `backend/src/routes/calendar.js` — `GET /events` używa puli; wybór kalendarzy (`calendarIds`, `null`=wszystkie, puste=żadne) z weryfikacją własności po stronie SQL; `truncated`/`incompleteSeries` zamiast cichego skrócenia.
- `backend/vitest.config.js` + `backend/vitest.setup.js` **(nowy)** — testy jednostkowe na ścieżce inline (deterministycznie).
- `backend/package.json` — skrypt `benchmark:calendar`.

### Frontend
- `frontend/src/utils/api.js` — `signal` dla `listCalendars`/`listEvents`, `calendarIds`, `isAbortError()`. Zapis wydarzenia i wysyłka zaproszeń **nietknięte**.
- `frontend/src/components/CalendarPage.jsx` — anulowanie poprzedniego ładowania i przy odmontowaniu, ignorowanie `AbortError`, `incompleteSeries` w UI, selekcja pól ze store zamiast całego store, `createDayEventsResolver` w `useMemo`.
- `frontend/src/components/calendarView.js` — `layoutTimedEvents()` bez zagnieżdżonych skanów; `createDayEventsResolver()`.
- `frontend/src/locales/*.json` (9) — klucz `calendar.incompleteSeries`.
- `frontend/src/components/calendarView.test.js` — testy układu i indeksu dni.

### Testy (nowe)
- `calendar-regressions.test.mjs` (9 testów, root repo — zgodnie z instrukcją audytu)
- `backend/src/utils/calendarRecurrenceEquivalence.test.js` (50)
- `backend/src/services/calendarProjectionPool.test.js` (11)
- `backend/src/services/calendarResponsiveness.test.js` (1 — kryterium odbioru)
- `backend/src/routes/calendar.events.test.js` (8)
- `frontend/src/components/calendarResponsiveness.test.js` (12)
- `backend/benchmarks/calendar-projection-benchmark.mjs`

---

## 3. Pomiary przed/po (te same dane, to samo narzędzie)

`backend/benchmarks/calendar-projection-benchmark.mjs` — importuje **aktualny kod**, nie kopię algorytmu. 100 serii × 5 lat, okno 42 dni, 7 powtórzeń. Mediana/p95.

| Wariant | Mediana | p95 | Uwaga |
|---|---|---|---|
| **Oryginał `8273e3b`** | 145 ms | 158 ms | **błędne wystąpienia** (sekcja B) |
| Poprawka, pełny skan, bez cache formattera | 11 906 ms | 11 940 ms | poprawne, ale zbyt wolne (5 serii, ekstrapolacja) |
| Poprawka, pełny skan, z cache formattera | 1 081 ms | 1 096 ms | poprawne (5 serii) |
| Poprawka, prefiltr + cache, TZID | **2 478 ms** | 2 538 ms | **100 serii** |
| Poprawka, pełny skan, TZID | 21 547 ms | 21 694 ms | 100 serii |
| Poprawka, prefiltr + cache, UTC | 2 181 ms | 2 798 ms | 100 serii |

Rozdzielenie zysków (100 serii TZID, ten sam zbiór):

- **Cache formattera:** 11 906 ms → 1 081 ms przy 5 seriach (~11×). To dominujący zysk pojedynczego wątku.
- **Prefiltr zegara ściennego:** pełny skan 21 547 ms → 2 478 ms przy 100 seriach (**~8,7×**).
- **Workery (równoległość):** 2 483 ms → **1 105 ms** (2,25× ściany) **plus** uwolnienie pętli zdarzeń.
- **Layout tygodnia:** 1000 nakładających się wydarzeń **271 ms → 5,8 ms** (~47×).
- **Indeks dni:** 3000 wydarzeń × 42 dni × 50 powtórzeń: 5632 ms → 1681 ms.

### Kryterium odbioru (test `calendarResponsiveness.test.js`)

Timer 10 ms podczas rozwijania ciężkich serii:

| Tryb | Próbki timera | max opóźnienie |
|---|---|---|
| **Pula workerów** | > 5 (normalna praca) | < 100 ms |
| **Inline (stare zachowanie)** | **0** (timer zagłodzony) | zablokowany na cały czas ekspansji |

Przejście do poczty nie czeka więc na odpowiedź kalendarza. Test celowo porównuje oba tryby, żeby przestał chronić własność, gdyby workload przestał być ciężki.

### Zgodność algorytmiczna

- `layoutTimedEvents`: **4000 losowych przypadków, 0 rozbieżności** względem oryginału (kolumna i szerokość grupy), deterministyczny.
- `createDayEventsResolver`: **27 000 przypadków, 0 rozbieżności** względem `sortedDayEvents`.
- Prefiltr vs pełny skan: 8 kształtów reguł × 5 okien — identyczne wystąpienia (testy).
- `THISANDFUTURE`: identyczne na ścieżce szybkiej i pełnym skanie.

---

## 4. Ograniczenia (pozostałe)

1. **Licznik `COUNT` i bardzo stare serie nadal wymagają przejścia od początku.** `ical.js` nie oferuje sprawdzonego przewijania z zachowaniem fazy. Nie dodano „szybkiego przewijania”, bo bez testów równoważności było źródłem obecnej regresji. Koszt pokrywa cache + workery.
2. **Twardy timeout zabija workera.** Ekspansji nie da się przerwać kooperacyjnie, więc przekroczenie budżetu kończy się `terminate()` — tracone jest tylko to jedno zadanie, zgłoszone jako `truncated`.
3. **Anulowanie klienta a backend.** `AbortController` przerywa pobieranie, ale odwrotne proxy może nie propagować rozłączenia natychmiast; dlatego budżet pracy w workerze pozostaje konieczny.
4. **Cache projekcji opiera się na `etag`.** Każda ścieżka zapisu (GUI, CalDAV, sync) nadaje nowy `etag`, więc wpis unieważnia się sam. Gdyby pojawiła się ścieżka zmieniająca `raw_ical` bez zmiany `etag`, cache trzeba unieważnić jawnie (`clearCalendarProjectionCache()`).
5. **Metadane powtarzalności w kolumnach zamiast regexu** — rekomendacja audytu; nie zrobione, bo wymaga migracji i pomiaru `EXPLAIN` na realnej bazie. Regex w `raw_ical` pozostaje.
6. **Wirtualizacja długich list** — nie zrobiona (najpierw profilowanie, zgodnie z audytem).
7. **`RDATE`-only bez `DTSTART`** — udokumentowane zachowanie ical.js (zweryfikowane identyczne przed i po). Zmiana tego to świadoma zmiana semantyki, nie efekt optymalizacji.
8. **Brak weryfikacji na działającym kontenerze użytkownika** — pomiary są na danych syntetycznych i testach; audyt sam wskazuje, że udział w konkretnym zgłoszeniu trzeba potwierdzić na wdrożeniu.

---

## 5. Weryfikacja wykonana

| Sprawdzenie | Wynik |
|---|---|
| `calendar-regressions.test.mjs` (root) | **9/9 pass** |
| Backend `npx eslint src --max-warnings 0` | **clean** |
| Backend `npx vitest run` | **1665 pass**, 13 skip (integracje PG) |
| Frontend `npx eslint src --max-warnings 0` | **clean** |
| Frontend `npm test` | **2143 pass** |
| Frontend `npm run build` | **OK** (7,98 s) |
| `docker build backend/Dockerfile` | **OK** |
| Worker pool w kontenerze | **poprawne wystąpienia 09:00** |

---

## 6. Procedura wdrożenia

1. Ustaw gałąź roboczą. Zbuduj **oba** obrazy z **jednego jawnego SHA** (nie z ruchomego `dev`):
   ```bash
   docker build -f backend/Dockerfile \
     --build-arg BUILD_SHA=<SHA> -t ghcr.io/<owner>/inboxora-backend:<SHA> .
   docker build -f frontend/Dockerfile \
     --build-arg VITE_BUILD_SHA=<SHA> -t ghcr.io/<owner>/inboxora-frontend:<SHA> .
   ```
2. **Zapisz poprzednie digesty** przed podmianą:
   ```bash
   docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/<owner>/inboxora-backend:dev
   docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/<owner>/inboxora-frontend:dev
   ```
3. Zweryfikuj zgodność wdrożenia (nie ufaj nazwie tagu):
   ```bash
   docker exec NAZWA_KONTENERA_BACKENDU node -p 'process.env.BUILD_SHA'
   ```
4. Na środowisku testowym powtórz scenariusz: poczta → kalendarz → poczta/kontakty, w trakcie ładowania i po nim. Sprawdź, że lekkie żądanie API kończy się przed ekspansją, a przejście do poczty nie czeka. Zweryfikuj, że seria DAILY 09:00 pokazuje 09:00, a MONTHLY 31. — 31.
5. Dopiero potem ruch produkcyjny. Sukces builda nie jest dowodem wydajności.

## 7. Rollback

1. Przywróć poprzednie digesty (nie tag `:dev`):
   ```bash
   docker pull ghcr.io/<owner>/inboxora-backend@sha256:<POPRZEDNI_DIGEST>
   docker pull ghcr.io/<owner>/inboxora-frontend@sha256:<POPRZEDNI_DIGEST>
   ```
2. Zrestartuj z tymi obrazami. Weryfikacja: `BUILD_SHA` w backendzie = poprzedni SHA.
3. Rollback jest bezpieczny dla danych: **nie ma migracji schematu**, `calendar_events`/`calendars` bez zmian. Cache projekcji jest w pamięci procesu i ginie przy restarcie.
4. Rollback przywraca jednak **błędne wystąpienia** z sekcji B — to stan znany jako wadliwy, więc traktuj go jako tymczasowy.

## 8. Konfiguracja (opcjonalna)

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `CALENDAR_PROJECTION_WORKERS` | min(4, CPU−1) | liczba workerów |
| `CALENDAR_PROJECTION_TIMEOUT_MS` | 5000 | budżet na zasób |
| `CALENDAR_PROJECTION_MAX_QUEUE` | 2000 | limit kolejki (nadmiar = zgłoszony) |
| `CALENDAR_PROJECTION_MAX_ITERATIONS` | 100000 | limit kroków na zasób |
| `CALENDAR_PROJECTION_CACHE_TTL_MS` | 300000 | TTL cache projekcji |
| `CALENDAR_PROJECTION_CACHE_ENTRIES` | 500 | limit wpisów (LRU) |
| `CALENDAR_PROJECTION_CACHE_MAX_EVENTS` | 50000 | limit zdarzeń w cache |
| `CALENDAR_PROJECTION_DISABLED` | `0` | `1` = tylko inline (diagnostyka) |
| `CALENDAR_PROJECTION_CACHE_DISABLED` | `0` | `1` = bez cache |

Zwiększenie RAM, timeoutów ani limitu 100 000 **nie jest** naprawą algorytmu — poprawka polega na zachowaniu semantyki DTSTART, zdjęciu pracy z pętli zdarzeń i usunięciu powtarzalnych kosztów.
