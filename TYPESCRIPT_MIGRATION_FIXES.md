# Raport błędów wykrytych i naprawionych podczas migracji na TypeScript

Dokument prowadzony na bieżąco. Zawiera błędy **realne** (logiczne, kontraktowe,
runtime), które ujawniła migracja — a nie tylko kosmetykę typów.

Legenda: 🔴 realny błąd runtime/logiki · 🟠 błędny kontrakt API · 🟡 dług typowania

## 1. Błędy infrastruktury uruchomieniowej (aplikacja by nie wstała)

- 🔴 **Backend wskazywał nieistniejące pliki.** Po zmianie rozszerzeń skrypty
  `start`/`dev` i `Dockerfile` nadal uruchamiały `src/index.js`, którego już nie było.
  Naprawa: `tsconfig.build.json`, build do `dist/`, `start → node dist/index.js`,
  `dev → tsx watch src/index.ts`, wieloetapowy `Dockerfile`.
- 🔴 **Frontend ładował nieistniejący entry.** `index.html` wskazywał `/src/main.jsx`.
  Naprawa: `/src/main.tsx`.
- 🔴 **Worker puli projekcji kalendarza nie startował.** `new Worker(new URL('./calendarProjectionWorker.js'))`
  wskazywał plik, który stał się `.ts`. Naprawa: `Promise<string>`/loader `tsx` w źródłach,
  `.js` w buildzie.
- 🔴 **Playwright nie widział testów** (`testMatch: '**/*.spec.js'`). Naprawa: `.ts` (727 testów).

## 2. Błędy logiczne i kontraktowe ujawnione przez typy

- 🔴 **`MessageHeaderModal.onSubjectResolved` wymagany, a `ContextMenu` go nie podawał** —
  wywołanie callbacku rzuciłoby `TypeError`. Naprawa: bezpieczny domyślny no-op.
- 🔴 **Arytmetyka na `Date`** (`new Date(base + n)`) opierała się na niejawnej konwersji.
  Naprawa: `.getTime()`.
- 🔴 **`applyBulkConversationAction` używał `options.copyId`/`options.logicalMessageId`**,
  których nie było w kontrakcie (maskował to index signature z `...rest`). Pola dodane
  do interfejsu.
- 🟠 **`applyBulkConversationAction` wymagał `conversationIds`** mimo że przy `items`
  kod świadomie z niego nie korzysta. Kontrakt poprawiony.
- 🟠 **`snippetFromBody(text, html)`** — `html` jest opcjonalny; sygnatura wymuszała 2 argumenty.
- 🟠 **`emitGtdIfRelevant(..., actedFolders)`** — parametr realnie opcjonalny.
- 🟠 **`sendSystemEmail({ …, html })`** — `html` wymagany, a wywołania go pomijały.
- 🟠 **`listMessages`** — `unreadOnly`/`threaded`/`category` wymagane, choć opcjonalne.
- 🟠 **`planModseqSync`** — `maxKnownUid`/`serverExists` wymagane, choć opcjonalne.
- 🟠 **`getGtdSections` / `logicalMessageIdentity` / `onPluginActivationChanged`** —
  niedeterministyczna inferencja typu parametru (`{}` / `{ userId? }`); jawne interfejsy.
- 🟠 **`MessageToolbar` (`className`/`style`), `MessageDetailContent` (allow*), `EmptyState.children`,
  `ToolButton.active`** — wymagane propsy nigdy nieprzekazywane.
- 🔴 **`req.query` używane jako `string`** — Express zwraca `string | string[] | ParsedQs`;
  `?x[]=a` mogło trafić do funkcji przyjmującej string. Naprawa: wspólny, zawężający
  helper `src/utils/query.ts` (`queryString`/`queryInt`) w 6 trasach.
- 🔴 **`parseInt(number)`** dla parametrów już liczbowych (przymusowa konwersja przez string).
  Naprawa: `Number()`.
- 🟠 **`getAiStatus`** zwracał niespójny kształt `features` (`{compose,summarize} | {}`).
  Naprawa: interfejs zwracany `AiProviderStatus`.
- 🟠 **`rawBody`** zwracał `Promise<unknown>` (brak argumentu typu) → `Promise<string>`.

## 3. Dług typowania (usuwany systematycznie)

- 🟡 `@ts-nocheck`: start 267 plików. Wszystkie zdjęte z backendu (0), frontend 37 do
  naprawy. **Nie dodaję już nowych.**
- 🟡 Obejścia `as any` / `: any` wprowadzone wcześniej — zastępowane precyzyjnymi
  typami/interfejsami (inwentaryzacja: backend ~371 `as any`, frontend ~50).

## Stan weryfikacji (na koniec tej iteracji)

Backend `tsc --noEmit`: **335 błędów pozostałych** (drzewo w trakcie naprawy — bez maskowania).
Frontend: 37 plików z `@ts-nocheck` do naprawy.
Testy i buildy pozostają zielone; naprawy typu nie zmieniają zachowania (poza usunięciem
realnych błędów opisanych wyżej).

## 4. Iteracja: typowanie zewnętrznych API i realne zawężanie

- 🟠 **OAuth/OIDC**: odpowiedzi `token`/`device_code`/`discovery` były `unknown`. Dodane interfejsy `OAuthTokenResponse`, `DeviceCodeResponse`, `OidcDiscoveryDocument` (zamiast `any`).
- 🔴 **Niestandardowy fetch OIDC** zwracał obiekt-atrapę zamiast `Response`. Teraz zwraca prawdziwe `Response` (poprawne `ok`/`status`/`json`/`text`).
- 🟠 **CardDAV**: opcje żądania i nagłówki niedookreślone; dodany `DavRequestOptions` oraz `Record<string,string>` dla nagłówków.
- 🟠 **Todoist**: `todoistFetch` nietypowany (opts bez `body`, odpowiedzi `unknown`) → generyczny `todoistFetch<T>` + `TodoistTaskInput`/`TodoistErrorResponse`.
- 🟠 **CodexAuthError**: brak deklaracji `status`/`code`/`transient` i opcja `code` poza typem.
- 🟠 **Testy sieciowe**: `server.address().port` na unii `string | AddressInfo` → wspólny helper `src/test/net.ts#listeningPort` (realne zawężanie, głośny błąd zamiast cichego `undefined`).
- 🟠 **`ai.test.ts`**: opcje żądania bez `body` → `TestRequestOptions`.

## 5. Stan weryfikacji

Backend `tsc --noEmit`: **265 błędów** (z 474 po zdjęciu `@ts-nocheck`). Testy: 1785 passed / 0 failed. Lint: czysty.

