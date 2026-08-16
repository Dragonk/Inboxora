# MailFlow — Gmail-compatible threading

## Cel
Ujednolicić grupowanie wiadomości w wątki zgodnie z RFC 5322/RFC 5256 oraz rozszerzeniami Gmaila, zachowując istniejącą kompatybilność z IMAP i dotychczasowym UI.

## Stan wyjściowy
Repozytorium już posiada częściowe, historyczne threading: `in_reply_to`, `thread_references`, `thread_id`, `thread_key`, fallback po znormalizowanym temacie oraz zapytania listujące wątki. Plan zakłada wydzielenie algorytmu do testowalnych modułów i dopiero potem integrację/reconciliację.

## Podział na małe PR-y / gałęzie
1. `feat/mailflow-threading-foundation` — normalizacja Message-ID, parser `In-Reply-To`/`References`, tożsamość wiadomości, graf wątku, silnik deterministycznego wyznaczania root/thread key. Tylko moduły i testy jednostkowe.
2. `feat/mailflow-threading-persistence` — repozytorium threadingu, migracja/indeksy i bezpieczna integracja z zapisem wiadomości; deduplikacja per konto i obsługa wiadomości bez nagłówków.
3. `feat/mailflow-threading-reconciler` — reconciler dla synchronizacji poza kolejnością, audyt i rebuild; tryb dry-run, limity i transakcje.
4. `feat/mailflow-gmail-thread-adapter` — adapter Gmail IMAP/API semantics, jeśli potrzebny po weryfikacji kontraktu; bez mieszania zmian UI.
5. `feat/mailflow-threading-ui` — osobny PR na korekty widoku/reader pane/inline replies; wyłącznie po stabilizacji backendu.
6. `feat/mailflow-threading-docs` — dokumentacja operacyjna, rollout i migracja.

## Kolejność wykonania
- [ ] Foundation
- [ ] Persistence
- [ ] Reconciler + audyt/rebuild
- [ ] Adapter Gmail
- [ ] UI
- [ ] Dokumentacja i finalna weryfikacja

## Kryteria akceptacji
- deterministyczny wynik niezależnie od kolejności synchronizacji;
- poprawna obsługa wielokrotnych i składanych nagłówków;
- brak łączenia wiadomości z różnych kont;
- bezpieczny fallback dla brakujących/uszkodzonych nagłówków;
- brak ujawniania credentiali w logach;
- testy jednostkowe, integracyjne i migracyjne;
- każdy PR ma jeden temat, opis, testy i jest możliwy do niezależnego merge.

## Źródła standardów
- RFC 5322: https://datatracker.ietf.org/doc/html/rfc5322
- RFC 5256: https://datatracker.ietf.org/doc/html/rfc5256
- Gmail IMAP Extensions: https://developers.google.com/workspace/gmail/imap/imap-extensions
- Gmail Threads: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads

## Mapa planowanych modułów
```text
backend/src/services/threading/
normalizeMessageId.js
parseThreadHeaders.js
messageIdentity.js
threadGraph.js
threadingEngine.js
threadingRepository.js
threadingReconciler.js
providerAdapters/gmail.js

backend/src/scripts/
auditThreading.js
rebuildThreading.js
```

## Uwagi do realizacji
- Najpierw sprawdzić i wykorzystać istniejące kolumny oraz migracje, nie tworzyć równoległego modelu bez potrzeby.
- Nie wykonywać destrukcyjnego rebuildu automatycznie przy starcie aplikacji.
- Każdy etap po implementacji przechodzi testy i niezależny code review subagenta.
- Gałęzie należy tworzyć od aktualnego `main`/upstream, a nie od roboczej gałęzi lokalizacyjnej.
