# Inboxora — plan dostarczenia, jakości i współtworzenia

## Stan bazowy (31.08.2026)

- Wydany punkt bazowy: `v3.4.0` / `origin/main` `9fc779e`.
- Aktywna praca: `/opt/data/worktrees/inboxora-calendar-ux`, gałąź `feat/calendar-ux-davx5`.
- Lokalna weryfikacja aktualnego zestawu: frontend lint, 1831 testów, build i `git diff --check` są zielone. Pełna kontrola urządzeniowa PWA/DAVx5 oraz `hermes verify` z Compose nadal wymagają środowiska docelowego.
- Nie usuwamy żadnej gałęzi, worktree ani tagu przed audytem otwartych PR-ów, merge-base i aktywnych checkoutów.

## Zasady docelowe gałęzi

1. `main` jest wyłącznie gałęzią wydaniową. Trafia do niej wyłącznie PR z `dev`, po zielonych kontrolach i akceptacji.
2. `dev` jest jedyną gałęzią integracyjną. Każdy feature/fix/docs PR ma jako bazę `dev`.
3. Krótkotrwałe gałęzie `fix/*`, `feat/*`, `docs/*`, `ci/*` są dozwolone tylko jako źródła PR i są kasowane dopiero po merge oraz po potwierdzeniu, że nie są checkoutem aktywnego worktree.
4. Tag wersji i obrazy wersjonowane są niezmienne. `latest` może wskazywać ostatnie wydanie, a `dev` wyłącznie ostatni zielony build `dev`.
5. Nie ma bezpośrednich pushy do `main` ani `dev`; wymagane są checks i review. Zmiana ochron gałęzi nastąpi dopiero po odczycie aktualnej konfiguracji repozytorium.

## Relacja z upstream GitHub

- GitHub obecnie oznacza `Dragonk/Inboxora` jako fork `maathimself/mailflow`, co wyświetla komunikat typu „ahead of / behind”. To metadane sieci forków GitHub, a nie plik ani ustawienie gałęzi, które można skasować w Git.
- Żeby usunąć ten komunikat przy zachowaniu repozytorium, należy poprosić GitHub Support o **detach this fork from its fork network** dla `Dragonk/Inboxora`. Formularz wymaga zalogowania do konta właściciela; nie wolno do niego przekazywać credentiali automatyzacji.
- Detach nie zwalnia z zachowania wymaganych informacji o pochodzeniu i licencji. README zawiera jawne podziękowanie dla maathimself i wyjaśnienie, że Inboxora jest niezależnie rozwijanym forkiem o odmiennych celach funkcjonalnych i projektowych.

## Kolejność realizacji

### A. Domknąć aktywne poprawki na gałęzi funkcji

- Systemowe Back w zainstalowanym PWA i Android wrapperze: warstwa modalna/formularz → widok szczegółowy → ekran aplikacji; bez opuszczania aplikacji.
- Audyt pozostałych modali/overlayów i testy kontraktowe.
- Proxy DAV dla tras discovery w obrazie frontendowym i w przykładowym native nginx.
- Niezależne review, commit z trailerem `Assisted-by: Hermes Agent`, PR do `dev`, zielone CI.

### B. Uporządkować model dostarczania

- Utworzyć `dev` z aktualnego `main` po audycie zdalnych gałęzi i PR-ów.
- Zmienić workflow CI/PR tak, by sprawdzał `dev` oraz PR `dev → main`.
- Dodać workflow GHCR dla obrazu `:dev`, uruchamiany po zielonym pushu do `dev` i ręcznie (`workflow_dispatch`), bez zastępowania tagów wersji.
- Po zintegrowaniu całego uzgodnionego pakietu na `dev`: zweryfikować workflow, odczytać digest obrazu, przekazać użytkownikowi tag `dev` do testów. Nie wdrażać produkcyjnie.

### C. Dokumentacja i współtworzenie

- Skrócić README do: czym jest Inboxora, kluczowe funkcje, szybki start, odsyłacze do dokumentacji, licencja i wkład.
- Zbudować statyczną dokumentację GitHub Pages: użytkownik (logowanie, konto mailowe, kontakty/kalendarz/DAV, preferencje) oraz administrator (Docker, reverse proxy, aktualizacje, OIDC, kopie zapasowe i diagnostyka).
- Dodać linki do Pages w README i sprawdzać je w CI.
- Zaktualizować `CONTRIBUTING.md`: issue przed każdym bug fixem i feature, wymagany link PR → issue, feature autor deklaruje implementację albo pomysł, implementacja przez autora wymaga zgody maintainera, review i akceptacja przed merge.

### D. Watchery GitHub

- `issues` (15 min): stateful polling, cichy baseline; bugs → analiza/rekomendacja naprawy na `dev`, feature requests → argumenty za/przeciw i prośba o decyzję użytkownika.
- `PRs` (15 min): stateful polling i review po zmianie SHA; uprzejme, konkretne komentarze wyłącznie po faktycznym odczycie diffu, bez automatycznego merge.
- Każdy watcher używa explicit Arcane route oraz `ARCANE_PROJECT=mailflow` i `ARCANE_ROLE`.

## Bramy jakości

- test czerwony → implementacja → test docelowy → pełna suita, lint, build, `git diff --check`;
- niezależne review przed commitem/PR;
- PR i CI zielone przed merge do `dev`;
- ręczny test instalowanego PWA na telefonie dla Back i DAVx5;
- `dev → main` dopiero po akceptacji release przez maintainera.

## Jawne ograniczenia

- Nie odczytywać produkcyjnych sekretów ani `.env`.
- Nie publikować obrazu `dev` ani nie kasować gałęzi przed odpowiednimi bramami.
- Brak Docker Compose na runnerze blokuje tylko kontenerową bramkę lokalną; nie jest obchodzony.
