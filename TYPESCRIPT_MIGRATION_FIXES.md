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


## 23. Frontend: propsy komponentów, DOM i daty

- 🟠 **`Field.required`**, **`IconBtn.danger/disabled`**, **`ToolbarButton.danger/style/action/targetId`**,
  **`ChipInput.autoFocus/containerStyle`** — wymagane, choć w wywołaniach pomijane → domyślne wartości.
- 🔴 **`e.target.style` w `MessageList`** (20 miejsc) — `EventTarget` nie ma `style`; użyto `e.currentTarget`
  (zdarzenie jest na tym samym elemencie).
- 🔴 **`MessagePane`**: `doc.querySelectorAll("*")` nie dawało typowanych elementów →
  `querySelectorAll<HTMLElement>` + `Set<HTMLElement>` (realne typowanie DOM).
- 🔴 **Arytmetyka `Date`** w `MessagePane` i `calendarView` → `.getTime()`.
- 🟠 **SVG**: wspólne propsy `const common` → `SVGProps<SVGSVGElement>` (6 błędów).
- 🟠 **Opcjonalne parametry**: `applyLayout(customListWidth?)`, `api.resolveMessage(accountId?)`,
  `saveResult(label?)`, `handlePaneContextAction(data?)`.

## 24. Stan weryfikacji

Frontend `tsc`: **419 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 25. Frontend: konfiguracja AI, poller Codex, kontrakty pomocnicze

- 🔴 **`normalizeAiForm(raw = {})` i `isAiFormValid`/`buildAiSavePayload`** — parametr `= {}` dawał typ
  `{}`, więc odczyt `apiKeyConfig`/`chatgptConfig`/`connectionMethod` był niekontrolowany (30 błędów).
  Dodany `AiConfigFormInput` (+ `AiApiKeyConfig`, `AiChatGptConfig`).
- 🟠 **`createCodexDevicePoller({...} = {})`** — brak typu opcji → `CodexDevicePollerOptions` + `CodexDeviceFlow`.
- 🟠 **Opcjonalne parametry**: `laneAndVersion`, `queuePerCopyMutation`, `folderLabel(mappings?)`,
  `handleContextAction(data?)`, `mergeWaiting(waiting?)`, `api.calendar.updateEvent(idempotencyKey?)`.
- 🟠 **`ToolBtn.active`** i **`avatarImageCandidates(gravatarAvatars?)`** — domyślne wartości.

## 26. Stan weryfikacji

Frontend `tsc`: **365 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 27. Frontend: krotki kolorów, atrapy DOM, daty

- 🔴 **`parseColor`/`parseHex`/`parseFunctional`/`rgbToHsl`/`hslToRgb`/`rgbToHex`** zwracały `number[]`
  zamiast krotki `[r,g,b]`/`[h,s,l]`, przez co `hslToRgb(rgbToHsl(rgb))` nie typowało się (6 błędów).
  Wprowadzone krotki + `NAMED_COLORS: Record<string, [number, number, number]>`;
  `parseFunctional` przepisany na pętlę (bez `map` + `some(null)`).
- 🔴 **`panelLayout.test.ts`** — atrapy `document`/`getComputedStyle`/`localStorage` bez typów;
  **usunięte obejście `(globalThis as any)`**. `const dragListeners = {}` → typowany rekord.
- 🔴 **`calendarView`** — arytmetyka `Date` → `.getTime()` (4 błędy).

## 28. Stan weryfikacji

Frontend `tsc`: **340 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 29. Frontend: klienci API (`conversationApi`, `api`)

- 🔴 **`conversationApi`** — `buildConversationRequestHeaders(extraHeaders = {})`, `apiFetch(options = {})`
  i `list(params = {})` miały parametry `{}`, przez co odczyt `headers`/`accountId`/`folder` był niekontrolowany
  (21 błędów). Dodane `ConversationQueryParams`, `ConversationTargetOptions`, `BulkConversationOptions`.
- 🔴 **`api.ts`** — `request(...)` i `streamAiChat(...)` bez typów; `opts.headers["Content-Type"]` na `HeadersInit`
  nie typowało się. Przepisane na jawny `Record<string, string>` + `RequestInit` (19 błędów).
- 🟠 **`search`/`getContacts`/`listCalendars`/`listEvents`/`rebuild`** — opcje otypowane;
  `URLSearchParams.set` wymaga `string` → `String(...)` dla liczb i `is_auto`.
- 🟠 **Augmentacja `Error`** (frontend): `status`, `statusCode`, `code`, `details`, `source`, `sync`, `signedOut`.
- 🟡 **Test `ConversationRebuild`** sprawdzał dosłowną treść źródła `rebuild: (...)`. Zaktualizowany tak,
  by nadal wymuszał dokładnie ten sam zestaw opcji, dopuszczając adnotację typu.

## 30. Stan weryfikacji

Frontend `tsc`: **300 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 31. Frontend: GTD (sekcje, wątki, deep-link)

- 🔴 **`gtd.ts`** — funkcje operowały na `unknown` (`sections[key]`, `sec.threads`, `row.thread`),
  a `mergeWaiting`/`snapshotGtdThreadRemoval`/`restoreGtdThreadRemoval`/`setGtdThreadReadInSections`
  nie miały typów parametrów (25 błędów). Dodane `GtdThread`, `GtdSection`, `GtdSections`, `GtdRemovalSnapshot`.
- 🔴 **`findGtdFolderCollisions`**: `const byFolder = {}` → `Record<string, string[]>` (mapa państw).
- 🔴 **`mergeWaiting`**: `new Date(...) - new Date(...)` → `.getTime()`.
- 🟠 **`scheduleGtdThreadAutoRead`**, **`openDeepLinkMessage`**, **`computeSpriteLayout`** — opcje otypowane.

## 32. Stan weryfikacji

Frontend `tsc`: **267 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 33. Frontend: hook swipe, Sidebar, realny błąd `pointerType`

- 🔴 **`onContextMenu` używał `e.pointerType`** — `MouseEvent` nie ma `pointerType`, więc warunek
  „Desktop right-click only” był **zawsze prawdziwy**. Zamieniony na istniejący tracker dotyku
  (`favTouchStart.current`), zgodnie z intencją opisaną w komentarzu.
- 🔴 **`onDragLeave`: `e.currentTarget.contains(e.relatedTarget)`** — `relatedTarget` może być `null`
  (opuszczenie okna); dodane zawężenie `instanceof Node`.
- 🔴 **`useSwipeRow`** — opcje bez typów (`onLongPress`/`onSwipeLeft`/`onSwipeRight`/`onTap`/`message`),
  `latestRef = useRef({})` → `Partial<UseSwipeRowOptions<M>>`. Odkryte przy tym, że `onLongPress`
  dostaje **id** (wołający robią `toggleSelect(id)`), a nie obiekt — typ callbacku poprawiony;
  dodatkowo usunięte ryzyko `message === undefined` (wcześniej `message.id` bez sprawdzenia).
- 🟠 **`Dialog.footer/testId`**, **`CtxMenuItem.danger/disabled`**, **`NavItem.badge`** — domyślne wartości.
- 🟠 Tablica pozycji menu kontekstowego w `Sidebar` otypowana.

## 34. Stan weryfikacji

Frontend `tsc`: **237 błędów** (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: `tsc` 0 · testy 1785/0.


## 35. Frontend: ComposeModal (pliki, meta viewport, TipTap)

- 🔴 handleFileSelect(e) bez typu → files było unknown[], więc file.name/size/type były niekontrolowane.
  Dodany ChangeEvent<HTMLInputElement>.
- 🔴 document.querySelector(meta[name=viewport]) zwracał Element, a kod zapisywał .content
  — realny błąd typów DOM. Użyty querySelector<HTMLMetaElement>.
- 🔴 FileReader.result (string | ArrayBuffer | null) był dzielony bez zawężenia → możliwy wyjątek.
  Dodane sprawdzenie typeof result === string.
- 🟠 resizeImageToDataUrl(file) → Promise<string>; RichToolbar (onInsertImage?, isMobile?),
  TitleBtn.danger, AttachmentChips.mobile, TBtn (props + forwardRef<HTMLButtonElement, TBtnProps>).
- 🟠 onClick={handleSend} (async z opcjami) nie pasował do MouseEventHandler → jawna lambda z void.
- 🟠 editor.commands.setContent(htmlSource, false) — TipTap oczekuje SetContentOptions → { emitUpdate: false }.

## 36. Stan weryfikacji

Frontend tsc: 210 błędów (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 37. Frontend: store, poller Codex, rozmiar czcionki

- 🔴 **applyFontSize() to pusty stub bez parametru**, a wolajacy przekazuja rozmiar (store 796/1168).
  Zachowanie jest zamierzone (skalowanie robi MailApp reaktywnie), wiec parametr zostal dodany
  i udokumentowany zamiast usuwac wywolania.
- 🔴 **store/index.ts** — Object.entries/Object.values na wartosciach z create<any> dawaly unknown,
  wiec msgs/m/th byly niekontrolowane. Dodany StoreMessage; selektor selectSelectedMessageMid
  ma jawny typ parametru.
- 🔴 **store**: arytmetyka Date -> getTime; gtdSections typowane jako GtdSections.
- 🟠 **Poller Codex**: CodexDeviceFlow (flowId/intervalMs/expiresAt), CodexDevicePollResult,
  CodexDeviceState; timery jako ReturnType<typeof setTimeout>.
- 🟠 **api.calendar.createEvent/deleteEvent** — opcjonalne idempotencyKey/recurrenceId/scope.

## 38. Stan weryfikacji

Frontend tsc: 183 bledy (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 39. Frontend: AdminPanel i kolejne no-op stuby

- 🔴 loadFontSet() to kolejny pusty stub bez parametru, a wolajacy przekazuja klucz fontu.
  Zachowanie zamierzone (fonty lazy-loadowane przez @font-face) — parametr dodany i udokumentowany.
- 🔴 AdminPanel: aktualizacja konta budowala obiekt bez typu, wiec dopisywanie auth_user/auth_pass/
  smtp_auth_user/smtp_auth_pass bylo niekontrolowane -> Record<string, unknown>.
- 🔴 configs useState({}) oraz codexStatus (reconnectRequired/reason/accountLabel) otypowane;
  stan maxAttempts/windowMins byl liczba, a input ustawial string (rozjazd typow) -> stan jako string.
- 🟠 LayoutDiagram wolane z nieistniejacym propem layoutKey (komponent go nie uzywa) — usuniete.
- 🟠 AccountForm.initial, SubTabs.initialTab, SettingsSwitchRow.testId — opcjonalne.
- 🟠 blankForm(prefill), getGroupedActions -> ShortcutAction; Navigator.standalone w augmentacji.
- 🟠 playNotificationSound(id, customDataUrl?), api.runRules(accountId?).

## 40. Stan weryfikacji

Frontend tsc: 153 bledy (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 41. Frontend: MessagePane — realny blad renderMarkdown

- 🔴 REALNY BLAD RUNTIME: renderMarkdown bylo wywolywane w komponencie wyniku AI, ale
  NIE bylo zaimportowane z utils/renderMarkdown.ts. Przy kazdym wyniku AI (streszczenie itp.)
  grozil ReferenceError: renderMarkdown is not defined. Dodany brakujacy import.
- 🔴 MessagePane: aiAbortRefs = useRef({}) -> Record<string, AbortController|undefined>;
  paneActionsRef otypowany (reply/replyAll/forward/toggleStar/print); contextMenu otypowany;
  document z iframe otypowany jako Document|null (wczesniej any blokowalo generyczne querySelectorAll).
- 🔴 aiResults: getResults/saveResult/read/write otypowane (AiActionResult, AiResultsStore).
- 🟠 expandScrollContainers(root: ParentNode|null) + querySelectorAll<HTMLElement>.
- 🟠 MobileModuleHeader.title/subtitle, ConversationMessage.onInitialBodyLayout,
  MessageDetailContent.onInitialBodyLayout, MessageToolbar.targetId/scrollAnchorId — opcjonalne.
- 🟠 MessageToolbar.shortcutLabel domyslnie przyjmuje argument (bylo () => null przy wywolaniu z argumentem).

## 42. Stan weryfikacji

Frontend tsc: 112 bledow (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 43. Frontend: sidebar, body status, heartbeat WS, atrapy pamięci

- 🔴 sidebar.ts: Set/obiekt drzewa folderow bez typow (path/children) -> SidebarFolderNode;
  localeCompare na unknown byl niekontrolowany.
- 🔴 MessageDetailContent: status = {} -> jawny typ (loading/error/unavailable);
  wczesniej kazdy odczyt status.* byl niekontrolowany.
- 🔴 useWebSocket: wlasne pola na WebSocket (_lastActivity/_pingInterval) -> HeartbeatWebSocket;
  patch = {} -> typ; zmiany z WS jako jawna tablica { id, is_read, is_starred }.
- 🔴 ContactsPage: value.trim() na unknown w filtrach adresow (Object.entries) -> zawężenie typeof string.
- 🟠 folderOrder.test: atrapa localStorage nie implementowala Storage; pelna implementacja
  (getItem/setItem/removeItem/clear/key/length + value).
- 🟠 DetailSection.label i ActionBtn.danger/disabled — opcjonalne.

## 44. Stan weryfikacji

Frontend tsc: 79 bledow (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 45. Frontend: bridge natywny, mostek Electron, Diagnostyka, MailApp

- 🔴 callNative(method, args) wymagalo args, a wiele wywolan przekazywalo tylko metode
  (resetHost/openPushHelp itd.) -> args opcjonalny.
- 🔴 takePendingDeepLink() nie mialo typu -> Promise<unknown>; teraz Promise<string|null>.
- 🔴 DiagnosticsReportModal: stan {status} nie mial pol json/report/error, ktore kod przypisywal.
- 🔴 getEffectiveShortcuts zwracalo {}, przez co odczyt toggleRightSidebar byl niekontrolowany.
- 🟠 globalne okna mostka natywnego (__inboxoraNativeBridgeReady, __inboxoraPendingNativeActions,
  __mailflowPendingNativeActions) dodane do Window.
- 🟠 MailApp: Object.values(threadMessages) -> jawny typ; querySelector<HTMLElement>?.focus();
  syncNow(accountId?) — opcjonalny.
- 🟠 inert={... ? undefined : true} wymagalo augmentacji React 18 (HTMLAttributes<_T>.inert) —
  typy React 18 nie znaja atrybutu inert.

## 46. Stan weryfikacji

Frontend tsc: 58 bledow (z 661). Testy 2335/0 · lint czysty · build OK.
Backend: tsc 0 · testy 1785/0.


## 47. POPRAWKA: bledne scalenie typow React (self-inflicted, wykryte)

W poprzednim commicie (71f5106) augmentacja HTMLAttributes uzyla parametru _T zamiast T,
aby wyciszyc ostrzezenie ESLint o nieuzywanym parametrze. TypeScript wymaga IDENTYCZNEJ
listy parametrow typu przy scalaniu interfejsow — _T nie scalilo sie z typami React,
co chwilowo zepsulo typowanie calego JSX (58 -> 883 bledow).

Naprawa: parametr wraca do T, a regula no-unused-vars jest wyciszona komentarzem
z uzasadnieniem. Stan: 58 bledow (zgodnie z oczekiwaniem).


## 48. Frontend: ostatnie pliki poza MessageList

- 🔴 selectAiConnectionMethod zwracalo obiekt bez pola device, a test przypisywal je, by sprawdzic
  brak wycieku — poprawione po stronie testu (spread), bez zmiany typu produkcyjnego.
- 🔴 exec(cmd, val) w SignatureEditor wymagalo val, a przyciski toolbaru wolaja z jednym argumentem.
- 🟠 CommandPalette: tablica akcji bez typu (pole active poza typem) -> jawny typ + ReactNode.
- 🟠 MobileModuleHeader.leading opcjonalny; CalendarPage uzywa go bez leading.
- 🟠 calendarView: Set z geometrii -> Set<number> (arytmetyka na unknown).
- 🟠 aiConfig/gtd: wstrzykiwane timery nie musza byc setTimeout -> typy jako unknown z bezpiecznym
  clearTimer; testy dostosowane.

## 49. Stan weryfikacji

Frontend tsc: 39 bledow (z 661) — WSZYSTKIE w MessageList.tsx.
Testy 2335/0 · lint czysty · build OK. Backend: tsc 0 · testy 1785/0.


## 50. MILESTONE: frontend bez bledow tsc — caly projekt otypowany

Frontend tsc: 0 bledow (start remediacji po zdjeciu @ts-nocheck: 661).
Pliki z @ts-nocheck/@ts-ignore/@ts-expect-error: 0 (frontend + backend).

Ostatnia partia (MessageList):
- fetch params ({limit, offset} + doklejane accountId/folder/unreadOnly/threaded/category)
  -> MessageQueryParams; wczesniej kazde dopisanie pola bylo niekontrolowane.
- scRef = useRef({}) -> jawny typ (messages/selectedIds/setSelectedIds/updateMessage/
  decrementUnread/addNotification/displayMessages) z poprawnym kontraktem setState dla Set<string>.
- targetsByRow -> Map<string, Map<string, ListMessage>>; deltaByAccount/deltaByCategory -> Record<string, number>
  (wczesniej delta > 0 na unknown).
- queuePerCopyMutation<T>(...) -> { promise: Promise<T> }, wiec await zachowuje typ wyniku.
- api.search limit: string|number; BulkBtn.danger/disabled opcjonalne; archiveVisibleMessage opcje otypowane.

## 51. Stan weryfikacji koncowej

Backend:  tsc 0 · testy 1785/0 · lint czysty · build OK
Frontend: tsc 0 · testy 2335/0 · lint czysty · build OK
Maski: 0 plikow z @ts-nocheck/@ts-ignore/@ts-expect-error.


## 52. Frontend: usuwanie obejsc any (produkcja)

Frontend any: 64 -> 48 (tsc nadal 0). Naprawione realnie (bez maskowania):
- CalendarInvitationCard/CalendarContextMenu: stale stylow -> CSSProperties, usuniete rzutowania as any.
- SenderAvatarImage: imageStyle oraz style -> CSSProperties (position/boxSizing byly szerokim string).
- GtdSettings: lokalny inputStyle byl nietypowany (boxSizing: string) -> CSSProperties.
- replyAlias.collectOwnAddresses: account/message otypowane (OwnAddressAccount/OwnAddressMessage);
  zawężenie aliasu string|obiekt.
- panelWidth.beginResize: onResize/onEnd -> (width: number) => void.
- classification.ts: notification z onUndo zamiast (notification as any).onUndo.
- messageQuoteFolding: uniqueTopLevel(elements: Element[]) — contains bez rzutowania.
- WindowLayer/MessageWindow: Object.values(threadMessages) -> jawny typ.
- RichTextEditor: setContent(next, { emitUpdate: false }) zamiast false as any.
- MessageHeaderModal.onSubjectResolved: (_subject: string).


## 53. Frontend: typy mostka natywnego i undoable commit

- 🔴 global.d.ts: inboxoraNative/Capacitor/webkitAudioContext/__inboxoraHandleAndroidBack byly any.
  Zdefiniowany pelny InboxoraNativeBridge (notifications/badges/updates/actions/platform,
  getHost/saveHost/resetHost) wraz z typami wynikow (status, push, update, copy/install).
  Ujawnilo to i otypowalo wszystkie uzywane metody (checkPermission/showNewMail/onPush/
  installAuto/openDownload/getPending/ack/onAction).
- 🔴 undoableAction.createUndoableCommit: opcje bez typow -> UndoableCommitOptions
  (schedule/cancel jako wstrzykiwane funkcje), usuniete as any z 6 miejsc w testach.
- Frontend any: 48 -> 38 (tsc 0, testy 2335/0, lint czysty).


## 54. FRONTEND: zero any i zero bledow

Frontend: 0 wystapien as any / : any / any[] (start: 64). tsc 0 · testy 2335/0 · lint czysty · build OK.

- TestGlobals (global.d.ts): jawne, udokumentowane typy podmienianych globali (fetch/localStorage/window)
  -> 30 miejsc (globalThis as any) zamienione na (globalThis as unknown as TestGlobals).
- pushWorker worker(matchAll) -> jawny typ zwracany (listeners/shown/sent).
- centeredScrollLeft: parametry opcjonalne (Number.isFinite(undefined) -> 0, zachowanie bez zmian).
- createInvitationOperationController: { randomUUID?: () => string } — wczesniej domyslna wartosc
  zawężała typ do szablonu UUID, co wymuszalo (… as any) w testach.
- isTrustedNativeMessage: parametry strukturalne (NativeMessageEvent/ExpectedWindow) zamiast Window.
- mobileMenu/CalendarContextMenu -> CSSProperties; useSwipeRow.test/nativeActionSecurity.test otypowane.


## 55. Backend: rozpoczecie usuwania any (463 wystapien)

- imapManager.ts mial 44 any, glownie pola klasy zadeklarowane jako declare ...: any (38 pol).
  Proba otypowania ich hurtem (w jednym kroku) dala 69 bledow — pola maja zlozone,
  zroznicowane kontrakty (Map/Set/semafory/obiekty z .until). Zmiana zostala COFNIETA,
  by nie zostawiac galezi czerwonej; wymaga typowania pole-po-polu na podstawie uzyc.
- .backup/ (41 MB bundle z wczesniejszej sesji) dodany do .gitignore.
- Stan: backend 463 wystapien any, tsc 0; frontend 0 any, tsc 0.


## 56. Backend: vi.mocked zamiast as any (94 miejsc) + realne niezgodnosci

Backend any: 463 -> 331 (tsc 0, testy 1785/0, lint czysty).

- 94 wystapien __mock_x as any zamienione na vi.mocked(__mock_x) w 39 plikach.
  vi.mocked sprawdza sygnatury, co UJAWNILO 25 realnych niezgodnosci ukrytych przez any:
  * makiety query zwracajace { rowCount } bez rows (kontrakt to { rows, rowCount? }) — dodane rows: []
  * makiety getAiStatus bez wymaganych provider/reconnectRequired — dodane
  * makiety transportera SMTP bez verify — dodane
  * sanitizeGtdFoldersDetailed bez rejected/reserved — dodane
  * createAccountSmtpTransport bez status — dodane
  * makiety parseMessage bez attributes/senderName/senderEmail/deliveryAddresses — dodane
- calendar.test.ts: 35 x (await response.json()) as any -> zadeklarowany CalendarTestResponse.
- gtdPet: (descriptor as any).width/height -> PetDescriptor z width/height; parsePetJson otypowane.
- hostValidation.resolveForConnection: jawny ResolvedConnectionInfo (addresses/lookup opcjonalne) —
  wczesniej unia wymuszala lookup, gdy podano addresses.
- aiProvider AiProviderStatus.connection: any -> jawny kształt.


## 57. Backend: makiety fetch, cache favicon, sekcje GTD

Backend any: 331 -> 283 (tsc 0, testy 1785/0, lint czysty).

- senderFavicon.test: 24 x const fetchImpl: any = vi.fn(...) -> vi.fn<typeof fetch>(...)
  (zachowuje .mock/.mockClear, ktorych typeof fetch nie ma).
- senderFavicon: cache wynikow favikon byla typowana jako pelny RedisClientType,
  a test podstawia 3-metodowa atrape -> wprowadzony waski SenderFaviconCache
  (get/set/del) + SenderFaviconOptions (inwersja zaleznosci).
- cacheDouble(): any -> jawny interfejs z sygnaturami Mock<...>.
- gtdSections: emptySections() zwracalo {} (dynamiczne klucze) -> GtdSectionSummary/
  GtdThreadSummary + jawny GtdSectionsResult; getGtdSections ma teraz jawny typ zwracany.
  To odslonilo i otypowalo dostepy sections.todo / threads[0].message_id itd.
- Usuniete 46 x as any z gtdSections.test.ts (parametr getGtdSections byl juz otypowany).


## 58. Backend: augmentacje, JSON zewnetrzny, strumienie, martwy fallback

Backend any: 283 -> 260 (tsc 0, testy 1785/0, lint czysty).

- express.d.ts: caldavCredentialId/cardavCredentialId/davCredentialId -> string; pushDevice -> jawny kształt.
- express-session.d.ts: pendingMFAEnrollment -> boolean; oidcPending -> jawny kształt.
- contactFields: ValueValidator(value: unknown), typedValues(values: unknown),
  normalizeRichContactFields(body: RichContactBody); walidator URL zawęża typeof string.
- updateCheck / pushTransports: (data as any).x -> typowane odpowiedzi JSON.
- draft.ts: (streamInfo.message as any).on(...) -> zawężenie instanceof Readable z błędem
  (wcześniej możliwy wyjątek, gdy transport nie zwróci strumienia).
- providerConversationMetadata: ProviderConversationMetadata + ConversationMetadataInput;
  WYKRYTE: parseProviderMetadata NIGDY nie zwraca references (zweryfikowane grepem), więc
  fallback metadata.references był martwym kodem maskowanym przez as any — usunięty.
- contactTransfer: parseCsv -> string[][]; indeks kolumny bez as any (get(name) ?? "").
- mailNotificationEvent: opcje i webPush otypowane.

