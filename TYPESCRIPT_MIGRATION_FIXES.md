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


## 6. Iteracja: mapy bez typów i nagłówki MIME

- 🔴 **Mapy `= {}` gubiły typ i kaskadowały `unknown`** w `routes/mail.ts` (bulk-delete/move/archive):
  `byAccount`, `byFolder`, `byExpungeFolder`, `byTrashPath`, `srcDeltas`, `dstDeltas`, `srcTotals`,
  `folderDeltas`. Każda otypowana zgodnie z rzeczywistym kształtem (wiersz wiadomości vs licznik vs `{msg,newUid}`).
  Wcześniej błędny typ mógł prowadzić do wyjątku przy `undefined.map(...)`.
- 🔴 **`parseRawHeaders`/`parseHeadersInput` zwracały `{}`** → `parsed.subject` w handlerze nagłówków.
  Zwracają teraz `Record<string, string>`.
- 🟠 **`MessageHeadersRow`** — wiersz handlera `/messages/:id/headers` otypowany (id, account_id, uid, folder, subject…).

## 7. Stan weryfikacji

Backend `tsc`: **223 błędy** (z 474). `routes/mail.ts` i `services/messageParser.ts` — 0 błędów.
Testy: 1785 / 0 failed. Lint: czysty.


## 8. Iteracja: konfiguracja AI i pamięci podręczne resolverów

- 🔴 **`normalizeAiConfig(raw = {})`** — parametr bez adnotacji dostał typ `{}`, więc odczyt
  `raw.apiKeyConfig`/`provider`/`features` był niekontrolowany. Dodany `AiConfigInput` (z zgodnym
  kształtem legacy i „structured”).
- 🟠 **`AiProviderError`** — brak deklaracji pól `status`/`expose`; dodany `AiProviderErrorOptions`.
- 🟠 **Opcje żądań AI** (`timeoutMs`/`signal`/`secrets`/`maxTokens`/`allowEmpty`) — niedookreślone;
  dodane `ProviderRequestOptions`, `ParseSseOptions`, `CompleteOptions`; `fetchFn` z `Parameters<typeof fetch>`.
- 🔴 **`apiKeyHeaders`** tworzył obiekt bez `Authorization` w typie → dodane `Record<string, string>`.
- 🔴 **`resolverCache = {}` w `inboxRules`** — memo bez typu (`_archiveResolved`, `archiveFolder`,
  `archiveIsAllMail`, `_trashResolved`, `trashFolder`, `allTrashPaths`) → interfejs `ResolverCache`.
- 🟠 **`referencesAnchor(message = {})`** — wejście otypowane (`MessageReferencesInput`).

## 9. Stan weryfikacji

Backend `tsc`: **175 błędów** (z 474). Czyste m.in.: `routes/mail.ts`, `services/messageParser.ts`,
`services/aiProvider.ts`, `services/inboxRules.ts`, `services/automatedSeriesAnchor.ts`.
Testy: 1785 / 0 failed. Lint: czysty.


## 10. Iteracja: wiersze logiczne i pula projekcji kalendarza

- 🔴 **`consolidateLegacyLogicalRows(..., rows)`** — parametr bez typu dawał elementy `unknown`,
  przez co odczyt `row.id`/`row.conversation_id` był niekontrolowany. Dodany `LogicalMessageRow`.
- 🔴 **`new Promise((resolve) => ...)` bez argumentu typu** w puli projekcji → `settled: unknown[]`,
  więc odczyty `result.events`/`result.truncated`/`result.error` były niekontrolowane. Dodane
  `ProjectionJobResult` i `Promise<ProjectionJobResult>`.
- 🟠 **`cacheSet(..., { ttlMs, horizonStartMs, horizonEndMs } = {})`** — brak typu opcji → `CacheSetOptions`.
- 🔴 **`failures`/`events`/`truncatedSeries` bez typów** w puli → `ProjectionFailure`, `ProjectionEvent`,
  `ProjectionAggregate`; jawne typy zwracane `inlineProject`/`dispatchProjection`.

## 11. Stan weryfikacji

Backend `tsc`: **144 błędy** (z 474). Czyste m.in.: `routes/mail.ts`, `services/messageParser.ts`,
`services/aiProvider.ts`, `services/inboxRules.ts`, `services/automatedSeriesAnchor.ts`,
`services/conversationPersistence.ts`, `services/calendarProjectionPool.ts`.
Testy: 1785 / 0 failed. Lint: czysty.


## 12. Iteracja: profile providerów IMAP i konfiguracja klienta

- 🔴 **`PROVIDERS`** był unią różnych kształtów → odczyty `freshInboxSync`, `usesIdle`,
  `preferFreshBodyFetch`, `maxSyncIntervalMs`, `idleKeepaliveMs`, `maxPersistentPerHost` były przypadkowe.
  Dodany interfejs `ProviderProfile`.
- 🔴 **`makeClientCfg`** miało wcześniej obejście `: any` (moje) — zastąpione realnymi typami:
  `EmailAccountRow`, `ResolvedConnection`, `ConnectionPolicyLike`, `MakeClientCfgOptions`, `ImapClientCfg`.
- 🔴 **Realny błąd logiczny: `computeThreadId` wołane z 5 argumentami, przyjmuje 4** — nadmiarowy
  `sanitizeStr(subject)` był po cichu ignorowany. Usunięty (bez zmiany zachowania).
- 🔴 **`new Promise((_, reject) => ...)` bez argumentu typu** w sondzie staleness → `Promise<unknown>`,
  przez co `Promise.race` dawał `unknown`. Teraz `Promise<never>` (poprawny typ dla promise, który
  nigdy nie resolvuje).
- 🟠 **`logger: boolean`** nie pasował do `ImapFlowOptions` (`false | Logger`) → `logger: false`.
- 🟠 **`providerFetchQuery`** — dodany `ImapFetchQuery` (`bodyParts`, `threadId`).
- 🟠 **`Error.imapError`** dodane do augmentacji; usunięty mój wcześniejszy `details?: any` → `unknown`.

## 13. Stan weryfikacji

Backend `tsc`: **110 błędów** (z 474). `services/imapManager.ts` — 0 błędów.
Testy: 1785 / 0 failed. Lint: czysty.


## 14. Iteracja: wysyłka poczty i atrapy IMAP

- 🟠 **`mailOptions`** był literałem bez typu — dopisywanie `html`/`inReplyTo`/`references`/`attachments`
  było niekontrolowane. Typ `SendMailOptions` z nodemailer.
- 🔴 **`streamInfo.message.on(...)`** na unii `Buffer | Readable` — dodane realne zawężenie
  `instanceof Readable` z błędem, gdy transport nie zwróci strumienia (wcześniej mogło wybuchnąć
  „on is not a function”).
- 🔴 **`new Promise((_, rej) => ...)` bez argumentu typu** w APPEND z timeoutem → `Promise<unknown>`
  zatruwał `Promise.race` (destrukturyzacja `{ uid }` z `unknown`). Teraz `Promise<never>`.
- 🟠 **`ensureServerAutoSavedSentCopy`** wymagało pełnego `ImapManager`, choć używa 3 metod.
  Wprowadzony wąski interfejs `SentCopyManager` (+ `EnsureServerAutoSavedSentCopyInput`),
  więc testowa atrapa nie wymaga już rzutowania do pełnej klasy.
- 🔴 **`Promise.allSettled` z mieszanym `Promise.resolve()`** dawał `void` w wyniku; ujednolicone.
- 🟠 **`sendResult`** (`{ok:true}`) → opcjonalne pola `sentCopySaved`/`sentFolder`.
- 🟡 **`mockResolvedValue()`** bez argumentu (3 pliki testowe) → `mockResolvedValue(undefined)`.

## 15. Stan weryfikacji

Backend `tsc`: **84 błędy** (z 474). `routes/send.ts`, `routes/send.sent.test.ts` — 0 błędów.
Testy: 1785 / 0 failed. Lint: czysty.


## 16. Iteracja: OAuth/OIDC, auth, Codex i zaproszenia kalendarza

- 🔴 **`verifyOpts`** (`{audience}`) — dopisanie `issuer` było niekontrolowane → typ `{audience; issuer?}`.
- 🔴 **Odpowiedzi tokenów OAuth/OIDC** (`tokens`/`tokenData`) — `unknown` → `OAuthTokenResponse`/`OidcTokenResponse`.
- 🟠 **Dokument discovery OIDC** — `OidcDiscoveryDocument` + pętla po literalnych kluczach (`as const`).
- 🔴 **`makeInsecureFetch(signal)`** wymagał argumentu, a jest wołany bez niego (JWKS) → `signal?`.
- 🟠 **Mapy ustawień `{}` w `auth.ts`** (`settingsMap`, `policyMap`, `map`) → `Record<string, string>`.
- 🟠 **`cookieOpts`** z `sameSite: string` nie pasowało do `CookieOptions` → jawny typ.
- 🟠 **`streamCodexResponses`/`completeCodexText`** — `signal` wymagany, choć opcjonalny → `StreamCodexOptions`.
- 🔴 **`releaseFlow`** — `intervalMs`/`nextPollAt` realnie opcjonalne (SQL `COALESCE`), typ je wymuszał.
- 🟠 **`getStatus({userId, sessionId} = {})`** → jawny interfejs.
- 🟠 **`sendCalendarInvitation`** — `description`/`location` wymagane, choć opcjonalne.

## 17. Stan weryfikacji

Backend `tsc`: **38 błędów** (z 474). Czyste m.in.: `routes/oauth.ts`, `routes/oidc.ts`,
`routes/auth.ts`, `services/openaiCodexResponses.ts`, `services/calendarInvitation.ts`.
Testy: 1785 / 0 failed. Lint: czysty.


## 18. MILESTONE: backend bez `@ts-nocheck` i bez błędów `tsc`

Backend `tsc --noEmit`: **0 błędów** (start remediacji: 474, po zdjęciu `@ts-nocheck`).
Liczba plików z `@ts-nocheck` w backendzie: **0**.

Ostatnie poprawki tej iteracji:
- `search.ts` — `isNaN(Date)` → `Number.isNaN(d.getTime())` (realny błąd: `isNaN` dostawał Date).
- `push.integration.test.ts` — typ sesji syntetycznej (`Request["session"]`).
- `oidc.endsession.test.ts` — typ dokumentu discovery + nazwany mock `fetch`.
- `senderFavicons.test.ts` — jawny typ zwracany `getFavicon`; `Promise<void>`.
- `smtpTransport.test.ts` — typowany mock `createTransport` (`vi.hoisted<(options)=>unknown>`).
- `hostValidation.ts` — `createPinnedLookup` z jawnym `PinnedLookup` (poprawny kontrakt callbacku
  Node: `(err, address?, family?)`).
- `hostValidation.test.ts` — `server.listen(0, host, () => resolve())` (callback bezargumentowy).
- ESLint (backend): `no-undef` wyłączony dla `.ts` (typy takie jak `NodeJS.*` nie są globalami runtime).

## 19. Stan weryfikacji

Backend: tsc 0 · testy 1785 / 0 failed · build OK · lint czysty · 0 `@ts-nocheck`.
Frontend: 37 plików z `@ts-nocheck` — następny etap.


## 20. Frontend: rozpoczęcie usuwania `@ts-nocheck`

Zdjęto wszystkie 37 `@ts-nocheck` z frontendu. `tsc`: **661 błędów** (do naprawy).
Pierwsza partia: stałe stylów adnotowane jako `CSSProperties` (AdminPanel, ContactsPage,
CalendarSubscriptionsSettings, CalendarSidebar, TodoistTaskModal, MessageToolbar) — 661 → 635.

Testy frontendu: 2335 / 0 failed · lint czysty · build OK.


## 21. Frontend: stałe stylów i kontrakty

- 🔴 **`ui.tsx` `inputStyle`/`buttonStyle` bez typu** — `boxSizing: string` szerokie → 82 błędy
  `CSSProperties` w konsumentach. Dodane `CSSProperties`.
- 🟠 Stałe stylów adnotowane jako `CSSProperties` w `AdminPanel`, `CalendarPage`,
  `CalendarSidebar`, `CalendarSubscriptionsSettings`, `TodoistTaskModal`, `MessageToolbar`,
  `ContactsPage` (77 adnotacji).
- 🟠 **`isLatestPerCopyMutation`/`invalidatePerCopyMutation`** — 3. argument (`maybeVersion`)
  realnie opcjonalny (obsługiwany przez `laneAndVersion`) → domyślna wartość (42 błędy).

## 22. Stan weryfikacji

Frontend `tsc`: **506 błędów** (z 661 po zdjęciu `@ts-nocheck`). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0 · 0 `@ts-nocheck`.

