# Inboxora — dokończenie migracji do strict TypeScript: instrukcja dla agenta

Ten plik jest samowystarczalnym przekazaniem zadania. Cel: doprowadzić `dev` do **0 znalezisk** w
`tsconfig.strict.json` w OBU projektach, bez ani jednej suppresji i bez zmiany zachowania w czasie działania.

## Stan wyjściowy (zweryfikowany, zmierzony)

| Metryka | Wartość |
|---|---|
| Gałąź / HEAD | `dev` @ `d0a0e6e0` |
| backend strict | **234** znalezisk |
| frontend strict | **279** znalezisk |
| razem | **513** |
| `npx tsc --noEmit` (oba) | **0 błędów** |
| suppresje (`as any`, `: any`, `as unknown as`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`) | **0** |
| Drzewo robocze | czyste |
| Punkt startowy kampanii | 8459 -> 1689 -> 513 |

`tsconfig.strict.json` (oba projekty) to `{ extends: ./tsconfig.json, compilerOptions: { strict: true, noImplicitAny: true } }`.
`DbRow` to już `Record<string, unknown>` (nie `any`) — granica zdjęta.

## Twarde reguły (nie podlegają negocjacji)

1. **ZAKAZ** `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `as any`, `as unknown as`, DOWOLNEGO innego `as`,
   non-null `!`, oraz `: any`. Także tymczasowo. Na koniec grep musi pokazać 0.
2. **Zakaz zmiany zachowania**: nie wolno zamieniać `x.y()` na `x.y?.()`, ani dodawać `?? default` tylko po to,
   by ucichło „possibly undefined”. Zamiast tego popraw **deklarację**.
3. Jeśli znaleziska nie da się naprawić bez powyższego — **zostaw je i zaraportuj**, która deklaracja i w jakim
   pliku musi się zmienić. Nie obchodź reguł.
4. Typy bierz **z docelowej deklaracji**: `Parameters<typeof f>[0]`, `ReturnType<typeof f>`, `X['field']`,
   `Awaited<ReturnType<f>>`, `NonNullable<...>`, `Pick<Req,'headers'|'ip'>`. Zachowaj opcjonalność 1:1.
5. Testy, które **celowo** podają śmieci do walidatora, są poprawne. Typuj wejście walidatora jako niezaufane
   (`unknown`-owe pola), a wyjście jako zwalidowany kształt. Zdestrukturyzowany parametr z `= undefined` bez
   adnotacji wnioskuje `undefined` — dodaj adnotację.
6. Ten repo ma eslint z `--max-warnings 0`, a reguła `no-redeclare` **odrzuca przeciążenia funkcji** — używaj generyków.
7. Część testów sprawdza **treść źródła** regexem (np. `calendarResponsiveness.test.ts` na
   `visibleCalendarIds.includes(event.calendar_id)`, `ConversationRebuild.test.ts` na `startError.status === 429`).
   Przed zmianą nazwy/kształtu kodu sprawdź testy w tym samym katalogu. **Nigdy nie edytuj testu**, żeby dopasować kod.
8. Dwa testy wydajnościowe są **wrażliwe na obciążenie** i padają pod równoległym obciążeniem, a przechodzą w izolacji:
   `backend/src/services/calendarResponsiveness.test.ts` i `backend/src/services/messageParser.snippet.test.ts`
   (+ sporadycznie `calendarProjectionPool.test.ts`). To nie regresje — **nie łagodź ich progów**.

## Weryfikacja po KAŻDEJ partii (to jest sedno metody)

    cd backend   && npx tsc --noEmit 2>&1 | grep -c 'error TS'                      # MUSI być 0
    cd backend   && npx tsc -p tsconfig.strict.json --noEmit 2>&1 | grep -c 'error TS'   # MUSI maleć
    cd backend   && npm run lint                                                   # MUSI być czysto
    cd frontend  && npx tsc --noEmit 2>&1 | grep -c 'error TS'                     # MUSI być 0
    cd frontend  && npx tsc -p tsconfig.strict.json --noEmit 2>&1 | grep -c 'error TS'   # MUSI maleć
    cd frontend  && npm run lint                                                   # MUSI być czysto
    cd frontend  && npm test                                                       # 2335 testów, 0 fail
    cd backend   && TMPDIR=/var/tmp npx vitest run                                 # 1785 / 36 skipped, 0 fail

**Uwaga środowiskowa (ważna):** `/tmp` to mały tmpfs z kwotą użytkownika. Bez `TMPDIR=/var/tmp` vitest
potrafi wywalić WSZYSTKIE pliki z mylącym `Unknown system error -122` (EDQUOT). Zawsze używaj `TMPDIR=/var/tmp`.
Jeśli quota się wyczerpie: usuń własne pliki tymczasowe i stare worktree (`git worktree remove --force /tmp/ibx-wtN`).

## Metoda, która zmierzona działa (i czego nie robić)

**Działa:** jeden plik na jednego subagenta + gotowa lista znalezisk; partie do pomiaru po ~10; scalanie plików
z **zabezpieczeniem bazowym** (nie nadpisuj pliku, który w `dev` jest już nowszy); partie **6 subagentów na jedno
wywołanie** (większe partie bywają przerywane, a wtedy agenci zostają zapisani, ale **nie uruchomieni** — trzeba im
wysłać wiadomość, by ruszyli).
**Nie działa:** szerokie partie 40+ plików na raz; mechaniczne reguły po nazwach parametrów (pogarszają wynik).

### Pętla
1. Wygeneruj listę plików z największą liczbą znalezisk i zapisz dla każdego plik `/tmp/task-N.txt`
   (`FILE: <projekt>/<ścieżka>`, `FINDINGS: n`, potem wiersze `L<linia> [TSxxxx] <komunikat>` + treść linii).
2. Dla każdego zadania: `git worktree add --detach /tmp/ibx-wtN HEAD`, podlinkuj `node_modules`
   (`ln -s <repo>/<proj>/node_modules`), skopiuj `tsconfig.strict.json`.
3. Uruchom **6** agentów na raz (prompt: jeden plik, zero suppresji, brak zmiany zachowania, pomiar w partiach,
   autoryzacja na minimalną zmianę deklaracji w pliku, którego nie ma na żadnej liście zadań).
4. Sprawdź, czy faktycznie działają; tym, które mają status `ready`, wyślij `send_message` z poleceniem startu.
5. Gdy skończą: scal pliki, których **zwykły build w worktree = 0**, z zabezpieczeniem bazowym; zmierz `dev`;
   jeśli zwykły build w `dev` wzrósł — **cofnij winny plik** (`git checkout -- <plik>`) i oddaj go do kolejnej partii.
6. Commituj partię i powtarzaj, aż oba projekty = 0.

### Znane przyczyny wymagające zmian w plikach „cudzych” (autoryzuj agenta albo zrób sam)
- `frontend/src/store/index.ts`: `setGtdPetSlug(slug: string | null)`, `hiddenFolders: Record<string, string[]>`,
  `setHiddenFolders`, `setBackfillProgress(..., | null)`, `setSelectedMessage(id: string | null)` — już częściowo zrobione;
  sprawdź, co jeszcze zgłasza strict.
- `frontend/src/utils/gtd.ts`: `GtdThread` (`id`, `account_id`, `message_id: string | null`) i `openDeepLinkMessage`.
- `frontend/src/components/GtdSidebarContent.tsx`: `rowActions` i `t: TFunction` zamiast `unknown`/luźnej funkcji.
- `frontend/src/components/CalendarPage.tsx`: `visibleCalendarIds.includes(event.calendar_id)` — zawęź w wywołaniu
  (`typeof event.calendar_id === 'string' && …`), bo tekst wyrażenia jest zakotwiczony testem.
- `frontend/src/utils/senderAvatar.ts` i `backend/src/services/emailSanitizer.ts` — **już naprawione** wzorcowo
  (adnotacja zdestrukturyzowanego parametru; generyki `T extends string | null | undefined`). Użyj tych wzorców.
- `backend/src/services/db.ts`: `query<T>()` zwraca `{ rows: T[]; rowCount?: number }` — rozważ `rowCount: number`
  u źródła (uwaga: dotyka wszystkich wywołań; zrób to osobno i przetestuj).
- `backend/src/services/unifiedInbox.ts`, `plugins/api.ts` (`PluginAccount.id`, `PluginMessage`),
  `plugins/mailEngine.ts`, `services/labels.ts`, `services/encryption.ts` + konsumenci — wcześniej raportowane blokady.

## Zakończenie (definition of done)

1. `npx tsc -p tsconfig.strict.json --noEmit | grep -c 'error TS'` = **0** w `backend` i w `frontend`.
2. `npx tsc --noEmit` = 0, `npm run lint` czysto, `npm test` (frontend) i `TMPDIR=/var/tmp npx vitest run` (backend) zielone.
3. Grep po suppresjach = **0**:

       grep -rnE 'as unknown as|:\s*any\b|as any\b|@ts-ignore|@ts-nocheck|@ts-expect-error' backend/src frontend/src | grep -v '//' | wc -l

4. **E2E**: uruchom testy Playwright (`npm run test:e2e` w katalogu e2e/frontend) — ostatni pełny przebieg:
   360 passed / 0 failed / 357 skipped. Napraw każdą realną regresję.
5. **Dokumentacja**: zaktualizuj `docs/CHANGELOG.md` (wersja **4.0.1**) i `docs/wiki/Release-notes-4.0.1.md`
   oraz `TYPESCRIPT_MIGRATION_STATUS.md` i `docs/wiki/Development.md` — wpisz **zmierzone, ostateczne liczby**
   (0 znalezisk strict w obu projektach, 0 suppresji, brak JS) i usuń wszelkie wzmianki o pozostałych krokach.
   Popraw też odwołania do JavaScriptu w dokumentacji.
6. `git push origin dev`.
7. Przebuduj obrazy Docker dla `dev` (workflow `publish.yml` z gałęzi `dev`), np.:

       gh workflow run publish.yml --ref dev -f source_sha=$(git rev-parse dev)

   Sprawdź przebieg (`gh run list --workflow=publish.yml --limit 3`) i w razie `qemu: Illegal instruction`
   (exit 132) na arm64 powtórz przez `gh run rerun <id> --failed`.

## Uwagi końcowe

- Nigdy nie zgłaszaj sukcesu bez zmierzonych liczb. Każdy raport agenta ma zawierać: znaleziska przed/po,
  sumę strict w obu drzewach przed/po, wynik `tsc`, wynik lintu, wynik testów, listę zmienionych plików.
- Jeżeli plik po scaleniu psuje zwykły build — cofnij ten plik, nie zostawiaj `dev` w stanie czerwonym.
- Utrzymuj drzewo czyste i commituj po każdej partii.
