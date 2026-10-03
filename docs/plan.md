# QAJitsu — plan architektury i wdrożenia

> **Background document (Polish), exported from the planning conversation on 2026-10-03.** It explains *why* the design looks the way it does.
> The binding sources are: requirements in [`docs/requirements/`](requirements/README.md) (`REQ-*` ids), the [roadmap](roadmap.md),
> invariants in [`.claude/rules/architecture-invariants.md`](../.claude/rules/architecture-invariants.md) and [ADRs](adr/). When this plan and the catalogue disagree, the catalogue wins.
>
> Naming used in code: the product is **QAJitsu**, the CLI is `qajitsu` (alias `qj`), packages are `@qajitsu/*`. Where this plan writes `qa <command>` or `@qa/steps`, read `qajitsu <command>` and `@qajitsu/steps`.
>
> Mapping of the original requirements R1–R17 to the catalogue:
>
> | Plan | Catalogue | Plan | Catalogue |
> | --- | --- | --- | --- |
> | R1 | REQ-CTX-01, REQ-CTX-03, REQ-CTX-06 | R10 | REQ-WS-01..04 |
> | R2 | REQ-PLAN-01..07 | R11 | REQ-VER-01..10 |
> | R3 | REQ-ENV-01, REQ-ENV-03 | R12 | REQ-GEN-01..05 |
> | R4 | REQ-PLAN-01, REQ-EXEC-04..07 | R13 | REQ-ENV-06, REQ-EXEC-06, REQ-EVD-03 |
> | R5 | REQ-EVD-04, REQ-EVD-05 | R14 | REQ-CTX-02 |
> | R6 | REQ-EVD-01 | R15 | REQ-CTX-04, REQ-CTX-05 |
> | R7 | REQ-EVD-02, REQ-EVD-03, REQ-PUB-06 | R16 | REQ-LLM-01..07 |
> | R8 | REQ-PUB-01..04 | R17 | REQ-CI-01..05 |
> | R9 | REQ-CFG-01..07 | logs, graph | REQ-OBS-01..08 |

## 1. Cel i wymagania

Framework przyjmuje klucz biletu Jira, a oddaje zatwierdzony plan, wykonane testy z dowodami oraz komentarz w Jirze. Da się to zbudować z dostępnych dziś narzędzi; najtrudniejsze są środowisko lokalne i wiarygodność wyników, więc tym dwóm tematom plan poświęca najwięcej miejsca.

| ID | Wymaganie |
| --- | --- |
| R1 | Wejściem jest klucz biletu Jira. Framework sam pobiera bilet, repozytorium testów i repozytorium kodu. |
| R2 | Agent tworzy plan testów. Użytkownik go akceptuje albo nanosi poprawki, w dowolnej liczbie rund. |
| R3 | Środowisko można podać bezpośrednio (nazwa profilu albo URL) albo zaznaczyć, że framework ma je zbudować z repozytorium w podanej wersji. |
| R4 | Rodzaj testów zależy od zmiany: API, UI web, mobile albo ich kombinacja. |
| R5 | Wynikiem jest macierz testów z zatwierdzonego planu: co przeszło, a co nie. |
| R6 | Dla API evidence zawiera request i response każdego wywołania. |
| R7 | Dla UI i mobile evidence to screenshoty i krótkie filmy. Film z faila użytkownik może łatwo obejrzeć lokalnie. |
| R8 | Wynik i evidence trafiają do Jiry jako komentarz z załącznikami. |
| R9 | Zmienne i sekrety są zarządzane tak, żeby serwisy wystartowały lokalnie bez ręcznej konfiguracji. |
| R10 | Dane każdego uruchomienia leżą w folderze per bilet z unikalnym znacznikiem; po testach są czyszczone albo zostają. |
| R11 | Warstwa weryfikacji pilnuje, żeby fail był failem, a agent niczego nie zmyślał. |
| R12 | Framework jest generyczny: podpina się go do projektu przez konfigurację, bez zmian w jego kodzie. |
| R13 | Obsługiwane są aplikacje mobilne (Android i iOS), nie tylko API i web. |
| R14 | Obsługiwane są GitHub i GitLab od pierwszej wersji, także instancje self-hosted. |
| R15 | Repozytoria ze zmianą są pobierane zawsze, także przy testach na gotowym środowisku, żeby agent analizował kod, a nie tylko opis biletu. |
| R16 | Obsługiwanych jest wiele modeli LLM: dostawcy chmurowi, modele lokalne przez Ollamę i bramki zgodne z OpenAI, takie jak LiteLLM. Model przypisuje się osobno do każdej roli agenta. |
| R17 | Framework da się podpiąć do CI/CD (GitHub Actions, GitLab CI, inne przez obraz Dockera): akceptacja planu odbywa się w pipeline, a wynik może być warunkiem merge. |

**Zasada nadrzędna, z której wynika cała architektura:** agent planuje i pisze testy, ale ich nie ocenia. Testy uruchamia zwykły runner (Playwright, Appium), a status PASSED/FAILED pochodzi z jego wyniku, nie z wypowiedzi modelu. Dzięki temu wymaganie R11 jest spełnione konstrukcyjnie, a nie tylko „prośbą w prompcie”.

## 2. Przepływ end-to-end

Cały proces dzieli się na dwie fazy rozdzielone akceptacją planu: w pierwszej agent i człowiek ustalają, co testować, w drugiej framework wykonuje dokładnie to i nic więcej.

```text
Faza A: planowanie (agent + człowiek)          Faza B: wykonanie (runnery + bramki)
1. Kontekst: bilet, kod i diff (GitHub/GitLab)   6. Środowisko: --env albo --build
2. Analiza zmiany: API / web / mobile            7. Testy wykonywalne z planu (tsc, pokrycie, blokada asercji)
3. Plan testów (plan.vN.yaml)                    8. Wykonanie i evidence (status ustala runner)
4. Przegląd przez użytkownika  <-- poprawki -->  9. Weryfikacja: bramki + Audytor
5. Plan zatwierdzony i zamrożony (SHA-256) --->  10. Macierz, Jira, sprzątanie
```

Pętla poprawek trwa, dopóki nie zaakceptujesz planu; od kroku 6 wszystko działa na jego zamrożonej wersji. Jedno polecenie `qa test SHOP-482` przechodzi przez wszystkie kroki, zatrzymując się na akceptacji planu i na podglądzie macierzy przed publikacją.

## 3. Wybór technologii

Rekomenduję **TypeScript na Node.js (LTS)**. Playwright i WebdriverIO (Appium) są w nim natywne, serwery MCP do przeglądarki i urządzeń mobilnych to pakiety npm, a Vercel AI SDK daje jeden interfejs do wielu dostawców modeli, w tym Ollamy i LiteLLM. Jeden język dla frameworka i dla generowanych testów daje też dodatkową kontrolę: kompilator `tsc` odrzuci test, w którym agent wymyślił nieistniejącą funkcję. Python jest rozsądną alternatywą tylko wtedy, gdy zespół zna wyłącznie Pythona.

| Kryterium | TypeScript | Python |
| --- | --- | --- |
| Testy web i API | Playwright Test natywnie: fixtures, projekty, retry, trace, wideo, raport HTML | playwright-python + pytest; trace i wideo działają, mniej wbudowanych funkcji runnera |
| Testy mobilne | WebdriverIO + Appium, dojrzałe i typowane | Appium-Python-Client, dojrzały |
| Agenci i modele | Vercel AI SDK: wielu dostawców, Ollama, endpointy zgodne z OpenAI (LiteLLM), klient MCP | LiteLLM SDK albo Pydantic AI, podobnie szerokie wsparcie dostawców |
| Serwery MCP (Playwright, Appium, Jira) | ten sam ekosystem npm | działają jako osobne procesy, bez różnicy w użyciu |
| Kontrola wygenerowanego kodu | `tsc --noEmit` wyłapuje wymyślone API i literówki | mypy/pyright, w praktyce słabiej egzekwowane |
| Ocena | **rekomendowany** | dobry, jeśli zespół zna tylko Pythona |

**Stos technologiczny**

- **Monorepo:** pnpm workspaces, TypeScript, Node.js LTS.
- **Agenci i modele:** własna pętla agenta na Vercel AI SDK, z jednym interfejsem dla Anthropic, OpenAI, Google, AWS Bedrock, Azure, Ollamy i dowolnego endpointu zgodnego z OpenAI (LiteLLM, vLLM, LM Studio). Narzędzia MCP przez `@ai-sdk/mcp`. Szczegóły w sekcji 4.
- **Schematy i walidacja:** Zod dla planu, wyników, konfiguracji i manifestu evidence; eksport do JSON Schema.
- **Orkiestracja:** własna, prosta maszyna stanów z checkpointami w `run.json`. Bez ciężkiego silnika workflow na start.
- **Jira:** REST API (biblioteka `jira.js`); opcjonalnie Atlassian MCP do odczytu przez agenta.
- **Repozytoria:** git CLI (mirror w cache + `git worktree`), API GitHub (Octokit) i GitLab (Gitbeaker) do PR/MR, diffów, komentarzy i artefaktów CI.
- **Środowiska:** Docker Compose; opcjonalnie Testcontainers i stuby WireMock/Mockoon dla zależności zewnętrznych.
- **API:** Playwright `APIRequestContext` + `ajv` do walidacji odpowiedzi względem OpenAPI.
- **Web:** Playwright Test; Playwright MCP do rekonesansu przez agenta.
- **Mobile:** Appium + WebdriverIO (UiAutomator2 dla Androida, XCUITest dla iOS); oficjalny [appium-mcp](https://github.com/appium/appium-mcp) do rekonesansu. Alternatywa: Maestro (flow w YAML).
- **Raporty i media:** statyczny HTML, `exceljs` (XLSX), ffmpeg do kompresji wideo.
- **CLI i logi:** `commander` + `@clack/prompts` (interaktywne pytania), `pino` (logi JSONL).

## 4. Architektura i moduły

Orkiestrator jest zwykłym kodem, który prowadzi uruchomienie przez kolejne etapy i zapisuje checkpoint po każdym z nich. Agenci dostają wąskie zadania z ograniczonym zestawem narzędzi i zwracają dane zgodne ze schematem; wszystko, co decyduje o wyniku, leży po stronie kodu deterministycznego.

```text
CLI qajitsu (później web UI, plugin Claude Code)
  -> Orkiestrator (kod, nie agent): maszyna stanów, checkpointy w run.json
       -> Agenci (dowolny LLM + strażnik narzędzi): Analityk, Planista, Autor testów, Audytor, Healer
       -> Kod deterministyczny: workspace i środowisko, kontrole statyczne, runnery i evidence, bramki, raport i publikacja
            -> Adaptery: Jira, GitHub/GitLab, Docker Compose, sekrety, Appium/farmy, modele LLM
Autor --specy--> runnery;  Audytor --ocena--> bramki
```

Agenci przekazują dalej tylko pliki: Autor oddaje specy do kontroli i runnerów, a Audytor oddaje ocenę do bramek. Żaden agent nie zapisuje wyników ani evidence.

| Agent | Wejście | Wyjście | Dozwolone narzędzia |
| --- | --- | --- | --- |
| Analityk | bilet, diff, OpenAPI, `.qa/knowledge/` | `analysis.json`: zakres, typ zmiany, ryzyka | odczyt plików, Jira i Git tylko do odczytu |
| Planista | analiza, istniejące testy w repo testów | `plan.vN.yaml` | odczyt plików, zapis tylko do `plan/` (bez pliku zatwierdzonego) |
| Autor testów | zatwierdzony plan, repo testów, helpery | pliki w `specs/` | odczyt, zapis do `specs/`, Playwright MCP i appium-mcp na środowisku testowym |
| Healer | failujący spec, evidence faila | poprawiony spec | jak Autor; każda zmiana przechodzi porównanie AST asercji |
| Audytor | plan, `results/`, evidence z obrazami | `audit.json`: zgodny albo NEEDS\_REVIEW dla każdego przypadku | wyłącznie odczyt |

**Jak wywoływany jest agent.** Każdy etap to jedno wywołanie własnej pętli agenta z listą dozwolonych narzędzi, limitem tur i budżetem tokenów. Odpowiedź jest walidowana schematem Zod; niepoprawna wraca do agenta z listą błędów, a po trzech próbach etap kończy się błędem zamiast zgadywania. Strażnik narzędzi (`preToolUse` i `postToolUse`) to kod frameworka owinięty wokół każdego wywołania narzędzia: blokuje zakazane zapisy i adresy oraz zapisuje każde wywołanie do dziennika. Ponieważ pętla jest nasza, strażnik działa identycznie niezależnie od modelu.

**Wiele modeli: chmura, LiteLLM i Ollama**

Framework nie jest przywiązany do jednego dostawcy. Agenci działają na [Vercel AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers), który ma jeden interfejs dla wielu dostawców, a narzędzia MCP (Playwright, Appium, Jira) podłącza przez klienta `@ai-sdk/mcp`. Claude Agent SDK odpada jako rdzeń, bo działa z modelami Claude; da się go przepiąć na inne modele przez LiteLLM, ale tłumaczenie formatu wiadomości w tej ścieżce ma [znane błędy](https://github.com/BerriAI/litellm/issues/23841), a na takiej podstawie nie da się zbudować wiarygodnego narzędzia.

| Dostęp do modelu | Jak podłączony | Kiedy |
| --- | --- | --- |
| Anthropic, OpenAI, Google, Mistral | oficjalne providery AI SDK | najlepsze wyniki w długich zadaniach agentowych |
| AWS Bedrock, Azure OpenAI, Google Vertex | oficjalne providery AI SDK | firma ma umowę z dostawcą chmury |
| LiteLLM (bramka w firmie) | provider zgodny z OpenAI, wskazujący na proxy | jedno miejsce na klucze, limity, koszty i listę dozwolonych modeli |
| Ollama | [ai-sdk-ollama](https://github.com/jagreehal/ai-sdk-ollama) | modele lokalne, kod i dane nie opuszczają maszyny |
| vLLM, LM Studio, inne serwery | provider zgodny z OpenAI | dowolny serwer z API zgodnym z OpenAI |

Model przypisuje się do roli, a nie do całego frameworka:

```yaml
models:
  providers:
    anthropic: { type: anthropic, api_key: "secret://env/ANTHROPIC_API_KEY" }
    company:   { type: openai-compatible, base_url: https://litellm.acme.local/v1, api_key: "secret://env/LITELLM_KEY" }
    local:     { type: ollama, base_url: http://localhost:11434 }
  roles:
    analyst: company/strong        # aliasy modeli zdefiniowane w LiteLLM
    planner: company/strong
    author:  company/strong
    healer:  company/fast
    auditor: anthropic/<inny model niż autor>
    summary: local/<model w Ollamie>   # streszczenia diffu, opisy w raporcie
```

**Zasady**

- **Profil zdolności.** Każdy model ma sprawdzane przez `qa doctor` zdolności: wywoływanie narzędzi, odpowiedzi zgodne ze schematem, obraz (Audytor ogląda screenshoty), okno kontekstu. Framework nie pozwoli przypisać roli modelowi bez wymaganej zdolności.
- **Brak natywnych odpowiedzi ze schematem:** tryb JSON, walidacja Zod i ponowienie. Jeśli to nie wystarczy, etap kończy się błędem, a nie zgadywaniem.
- **Audytor na innym modelu niż Autor.** Dwa różne modele rzadziej popełniają ten sam błąd, więc to ustawienie zalecane domyślnie.
- **Modele lokalne realnie.** Dobrze radzą sobie z prostszymi zadaniami: streszczeniem diffu, klasyfikacją zmiany, opisami w raporcie. Długie zadania z wieloma narzędziami (Autor, rekonesans przez MCP) wymagają dużego modelu i mocnego GPU. Słabszy model częściej myli narzędzia, ale warstwa weryfikacji nie zależy od modelu, więc skutkiem jest więcej BLOCKED, a nie fałszywe PASSED.
- **Porównanie modeli.** `qa bench --model local/<model>` uruchamia demo-shop z celowymi błędami i pokazuje, ile błędów model wykrył, ile było fałszywych faili, czas i koszt. Pomaga dobrać model do roli, a opublikowane wyniki dobrze budują zasięg projektu.
- **Prompty bez sztuczek pod jeden model.** Testy regresji frameworka uruchamiane są na co najmniej dwóch dostawcach, w tym jednym lokalnym.
- **Koszt i tokeny per model i per rola** trafiają do dziennika uruchomienia.

## 5. Plan testów i akceptacja

Plan to plik YAML zgodny ze schematem. Użytkownik widzi jego czytelną wersję, poprawia go słowami albo edycją pliku, a akceptacja zamraża go hashem SHA-256. Framework odmawia uruchomienia czegokolwiek, czego nie ma w zatwierdzonym planie.

**Przebieg**

1. `qa plan SHOP-482` uruchamia agenta Analityka (bilet, AC, komentarze, powiązane bilety, pobrany kod i diff PR/MR) i agenta Planistę. Powstają `plan.v1.yaml` i `plan.v1.md`.
2. Terminal pokazuje plan i pyta: **\[a\]** akceptuj, **\[p\]** popraw (opis słowny), **\[e\]** edytuj plik w edytorze, **\[q\]** przerwij.
3. Przy poprawce słownej agent tworzy `plan.v2.yaml`, a framework pokazuje różnice: dodane, usunięte i zmienione przypadki.
4. Akceptacja tworzy `plan.approved.yaml` z hashem, autorem i datą. Od tej chwili plan jest tylko do odczytu.
5. Jeśli bilet jest niejasny, Planista nie zgaduje. Wpisuje pytanie do sekcji `open_questions`, a framework nie pozwoli zaakceptować planu z otwartymi pytaniami bez świadomego potwierdzenia.

**Co zawiera każdy przypadek**

- `id`, tytuł, typ (`api` / `web` / `mobile`), priorytet;
- `source`: kryterium akceptacji, dosłowny cytat z biletu albo plik z diffu. To podstawa kontroli halucynacji (sekcja 10);
- warunki wstępne i dane testowe (aliasy kont, nie hasła);
- kroki z identyfikatorami i oczekiwanym wynikiem dla każdego kroku;
- wymagane evidence.

```yaml
ticket: SHOP-482
plan_version: 2
scope: [api, web]
cases:
  - id: TC-01
    title: Dodanie produktu do koszyka zwraca 201 i przelicza sumę
    type: api
    priority: high
    source:
      ac: AC-1
      quote: "Po dodaniu produktu suma koszyka jest przeliczana"
    preconditions: ["konto: user:standard", "pusty koszyk"]
    steps:
      - id: S1
        action: POST /cart/items {sku: TEST-SKU-1, qty: 2}
        expect:
          status: 201
          body.total: "2 * price(TEST-SKU-1)"
    evidence: [request, response]
  - id: TC-02
    title: Koszyk w UI pokazuje nową sumę po dodaniu produktu
    type: web
    source: { ac: AC-1 }
    steps:
      - id: S1
        action: Otwórz stronę produktu TEST-SKU-1 i kliknij "Dodaj do koszyka"
        expect: { ui: "licznik koszyka pokazuje 1" }
      - id: S2
        action: Przejdź do koszyka
        expect: { ui: "suma równa cenie produktu" }
    evidence: [screenshot_per_step, video]
open_questions:
  - Czy limit 99 sztuk dotyczy też klientów B2B?
out_of_scope:
  - Płatności (bez zmian w tym bilecie)
```

**Później (opcjonalnie):** plan publikowany jako komentarz w Jirze i akceptowany przez innego testera komentarzem `/approve`, albo przegląd w prostym lokalnym UI z przyciskami. Na start wystarczy terminal i edytor.

## 6. Repozytoria, analiza kodu i środowisko

Repozytoria ze zmianą są pobierane przy każdym uruchomieniu, niezależnie od tego, gdzie idą testy, bo bez kodu agent może tylko zgadywać zakres zmiany. Środowisko podajesz wprost (`--env`) albo zaznaczasz, że framework ma je zbudować z pobranego kodu (`--build`). W obu przypadkach dokładna wersja (SHA commita) trafia do `run.json` i do komentarza w Jirze.

**Skąd framework wie, które repozytorium i która zmiana**

1. **Panel Development w Jirze:** powiązane pull requesty (GitHub) i merge requesty (GitLab), branche i commity. Wymaga integracji GitHub for Jira lub GitLab for Jira.
2. **Wyszukiwanie po kluczu biletu** w tytułach PR/MR i nazwach branchy (np. `feature/SHOP-482-koszyk`) w repozytoriach zadeklarowanych w `qa.project.yaml`.
3. **Wskazanie ręczne:** `--pr <url>`, `--mr <url>` albo `--ref <branch|tag|sha>`, gdy dwie pierwsze metody nic nie znajdą.

Jedna zmiana może obejmować kilka repozytoriów, np. backend na GitLabie i frontend na GitHubie; framework pobiera wszystkie i analizuje je razem.

**Co agent dostaje do analizy**

- Pełną kopię roboczą każdego repozytorium na SHA zmiany, nie tylko diff. Agent czyta i przeszukuje kod narzędziami tylko do odczytu (`Read`, `Grep`, `Glob`).
- Diff względem gałęzi docelowej PR/MR i listę zmienionych plików, bez plików generowanych i lock-file'ów.
- Opis, komentarze i wątki z code review PR/MR. Często są tam decyzje, których nie ma w bilecie.
- Pliki powiązane ze zmianą: testy jednostkowe z PR/MR, definicje endpointów, migracje bazy, tłumaczenia.

Na tej podstawie Analityk ustala typ zmiany (API, UI, mobile), dotknięte endpointy i ekrany oraz ryzyka regresji, a Planista może wskazać w `source` konkretny plik i linię kodu. Przy dużym diffie agent dostaje streszczenie i listę plików, a resztę przeszukuje sam, zamiast dostać całe repozytorium w kontekście.

**GitHub i GitLab od pierwszej wersji**

- Jeden interfejs `CodeHost` i dwie implementacje: wyszukanie PR/MR dla biletu, pobranie diffu i komentarzy, adres do klonowania, pobranie artefaktów CI (GitHub Actions, GitLab CI).
- Instancje self-hosted (GitHub Enterprise Server, GitLab self-managed) przez `base_url` w konfiguracji.
- Dostęp: GitHub przez fine-grained token albo GitHub App; GitLab przez project/group access token z uprawnieniami `read_api` i `read_repository`. Tokeny pochodzą od dostawcy sekretów (sekcja 7).
- Opcjonalnie framework dodaje krótki komentarz z wynikiem także w PR/MR.

**Pobieranie.** Mirror każdego repozytorium leży w cache (`~/.qa-cache/git`), a do folderu uruchomienia trafia `git worktree` na wskazanym SHA. Kolejne uruchomienia są szybkie, bo pobierają tylko nowe commity.

**Środowisko: podane albo zbudowane**

Gdy nie podasz ani `--env`, ani `--build`, framework bierze `environments.default` z konfiguracji projektu, a jeśli go nie ma, pyta.

**Tryb 1: środowisko podane (`--env`)**

- `--env staging` używa profilu `.qa/envs/staging.yaml` (URL-e, aliasy kont, flagi). `--env https://qa-12.example.com` podaje adres wprost; reszta ustawień pochodzi wtedy z profilu domyślnego.
- **Kontrola wersji.** Framework odczytuje wersję wdrożoną na środowisku (konfigurowalny endpoint, np. `/version` zwracający SHA) i porównuje ją z SHA zmiany. Jeśli się różnią, ostrzega przed testami: testujesz kod, którego tam jeszcze nie ma.
- Przed testami framework robi health check; jeśli środowisko nie odpowiada, wszystkie przypadki dostają status BLOCKED.
- Działa allowlista środowisk. Produkcja jest domyślnie zablokowana, a hook agenta odrzuca każde wywołanie na adres spoza allowlisty.

**Tryb 2: framework buduje środowisko (`--build`)**

1. **Wersja.** Budowane są dokładnie te same kopie robocze, które analizował agent, więc testowany kod jest tym, na podstawie którego powstał plan.
2. **Konfiguracja.** Rozwiązanie zmiennych i sekretów (sekcja 7) i wygenerowanie plików `.env` dla każdego serwisu.
3. **Start.** `docker compose` z plikiem projektu i nakładką generowaną przez framework: nazwa projektu = ID uruchomienia, dynamiczne porty, etykiety `qa.ticket` i `qa.run` na kontenerach, sieciach i wolumenach. Serwisy bez Dockera framework uruchamia komendą z konfiguracji (np. `npm run dev`) jako zarządzany proces z logami do pliku.
4. **Gotowość.** Health checki zdefiniowane w projekcie (HTTP 200, otwarty port, linia w logu) z limitem czasu, potem hook z danymi testowymi (`seed`).
5. **Błąd startu.** Wszystkie przypadki dostają BLOCKED, a logi serwisów trafiają do evidence. Agent może opisać prawdopodobną przyczynę w raporcie, ale nie może uznać testów za wykonane.

**Zależności zewnętrzne.** Nie każdy serwis musi startować lokalnie. Projekt może zadeklarować stub (WireMock, Mockoon) zamiast prawdziwej usługi, np. bramki płatności.

**Mobile lokalnie.** Najlepiej pobrać gotowy APK/IPA z artefaktów CI (GitHub Actions lub GitLab CI) dla danego SHA; budowanie z repo (Gradle, xcodebuild, EAS) jest wolne i zawodne. Emulator Androida framework startuje sam. Symulator iOS wymaga maszyny z macOS, więc testy iOS na Linuksie idą przez farmę urządzeń (BrowserStack, Sauce Labs, AWS Device Farm) jako osobny dostawca środowiska.

## 7. Zmienne i sekrety

Konfiguracja składa się z pięciu warstw, a każda kolejna nadpisuje poprzednią. Sekrety nigdy nie trafiają do repozytorium, do kontekstu modelu ani do evidence wysyłanego do Jiry.

| Warstwa | Gdzie leży | Co zawiera | W repo? |
| --- | --- | --- | --- |
| 1. Domyślne frameworka | pakiet `qa` | timeouty, polityka evidence i retencji | tak |
| 2. Profil projektu | `.qa/qa.project.yaml` | serwisy, schemat zmiennych każdego serwisu | tak |
| 3. Profil środowiska | `.qa/envs/<env>.yaml` | URL-e, flagi, odwołania do sekretów | tak |
| 4. Sekrety | dostawca sekretów | hasła, tokeny, klucze, konta testowe | nie |
| 5. Nadpisania uruchomienia | flagi CLI | jednorazowe zmiany, np. włączenie feature flagi | nie |

Każdy serwis deklaruje swoje zmienne. Wartość może być stała, szablonem odwołującym się do innego serwisu albo referencją do sekretu:

```yaml
services:
  orders-api:
    env:
      DATABASE_URL: { value: "postgres://qa:qa@{{svc.postgres.host}}:{{svc.postgres.port}}/orders" }
      PAYMENTS_URL: { value: "http://{{svc.payments-stub.host}}:{{svc.payments-stub.port}}" }
      JWT_SECRET:   { secret: "op://QA/orders-api/jwt_secret" }
      FEATURE_NEW_CART: { value: "false", overridable: true }
```

**Jak to działa**

- **Szablony** `{{svc.x.port}}` rozwiązują się do portów przydzielonych dynamicznie, więc dwa uruchomienia mogą działać równolegle.
- **Dostawcy sekretów** są adapterami: na start zmienne środowiskowe i plik `.env.local` (w `.gitignore`), później 1Password CLI, HashiCorp Vault, AWS/GCP Secret Manager, Doppler.
- **`qa env check`** waliduje komplet zmiennych przed startem. Brak wymaganej zmiennej to czytelna lista braków, a nie wywrotka serwisu w połowie testu.
- **Pliki `.env`** powstają w folderze uruchomienia z uprawnieniami 600 i są kasowane zawsze po testach, także przy `--keep`. `qa env render` odtworzy je na żądanie.
- **Maskowanie.** Framework prowadzi rejestr wartości sekretów i przed zapisem evidence zastępuje je `***`. Domyślnie maskuje też nagłówki `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` oraz pola JSON skonfigurowane w projekcie (np. `password`, `token`).
- **Skan przed publikacją.** Bramka przeszukuje wszystkie pliki evidence pod kątem wartości sekretów. Trafienie blokuje wysyłkę do Jiry.
- **Konta testowe przez aliasy.** Agent widzi tylko `user:standard` czy `user:admin`. Logowanie wykonuje helper frameworka (np. zapisany `storageState` w Playwright), więc hasła nie trafiają do kontekstu modelu.

## 8. Workspace per bilet, znacznik i sprzątanie

Każde uruchomienie dostaje folder `<root>/<BILET>/<RUN-ID>`, gdzie RUN-ID to data, godzina i 4 losowe znaki, np. `20261003-1046-k7f3`. Ten sam identyfikator jest w nazwach kontenerów, plików evidence i w komentarzu w Jirze, więc wszystko da się powiązać z jednym uruchomieniem.

```text
~/.qa-runs/
  SHOP-482/
    index.json                  # lista uruchomień: status, data, retencja
    latest -> 20261003-1046-k7f3
    20261003-1046-k7f3/
      run.json                  # kto, kiedy, SHA, środowisko, etap, status
      ticket/                   # zrzut biletu, AC, komentarzy, załączników
      plan/                     # plan.v1.yaml, plan.v2.yaml, plan.approved.yaml + hash
      repos/                    # git worktree aplikacji i repo testów
      env/                      # .env per serwis (kasowane), compose.override.yml
      logs/                     # logi serwisów i runnerów
      specs/                    # testy wygenerowane z planu
      results/                  # surowe wyniki runnerów (zapis tylko przez runner)
      evidence/
        TC-01/                  # req/resp, screenshoty, wideo, trace
        manifest.json           # SHA-256 każdego pliku
      journal/events.jsonl      # każde wywołanie narzędzia przez agenta
      report/                   # matrix.md, matrix.xlsx, report.html, jira-comment.json
```

**Zasady**

- **Lokalizacja** jest konfigurowalna. Domyślnie katalog domowy, żeby nie zaśmiecać repo projektu; alternatywnie `.qa-runs/` dodane do `.gitignore`.
- **Zasoby Dockera** mają etykiety `qa.ticket=SHOP-482` i `qa.run=20261003-1046-k7f3`, a nazwa projektu compose to `qa-shop-482-k7f3`. Sprzątanie po etykiecie usuwa też zasoby osierocone po przerwanym uruchomieniu.
- **Polityka w konfiguracji:** `cleanup: on_success | always | never`, `keep_last: 5` uruchomień na bilet, `max_age_days: 14`. Flaga `--keep` nadpisuje politykę dla jednego uruchomienia.
- **Co znika przy sprzątaniu:** kontenery, wolumeny, sieci, worktree, pliki `.env`. **Co zostaje przy `--keep`:** plan, specy, wyniki, evidence, raport, dziennik. Pliki `.env` znikają zawsze.
- **Blokada.** Plik `lock` chroni przed dwoma procesami zapisującymi do tego samego uruchomienia; różne uruchomienia tego samego biletu mogą iść równolegle.

**Komendy:** `qa runs SHOP-482` (lista), `qa resume SHOP-482` (wznowienie od ostatniego checkpointu), `qa clean SHOP-482 [--run <id>]`, `qa gc` (retencja dla wszystkich biletów i usuwanie osieroconych kontenerów).

## 9. Wykonanie testów: API, web, mobile

Agent Autor zamienia zatwierdzony plan na pliki testów, a uruchamiają je zwykłe runnery z wbudowanym rejestratorem evidence. Rekonesans agenta przez MCP (szukanie selektorów, poznawanie ekranów) jest dozwolony, ale nigdy nie liczy się jako wykonanie testu.

| Typ | Runner | Rekonesans agenta | Evidence zbierane automatycznie |
| --- | --- | --- | --- |
| API | Playwright `APIRequestContext` + `ajv` (zgodność z OpenAPI) | czytanie specyfikacji OpenAPI i kodu kontrolerów z diffu | request i response każdego wywołania (JSON), gotowa komenda cURL, czasy odpowiedzi |
| Web | Playwright Test | Playwright MCP | screenshot po każdym kroku, wideo, trace, logi konsoli, HAR |
| Mobile | WebdriverIO + Appium (Android: UiAutomator2, iOS: XCUITest) | appium-mcp | screenshot po każdym kroku, nagranie ekranu, logcat/syslog, źródło ekranu przy failu |

**Biblioteka kroków `@qa/steps`** łączy kod testu z planem. `step()` oznacza krok identyfikatorem z planu i robi screenshot (UI) albo zapisuje request/response (API). `verify()` wykonuje asercję i przypisuje ją do kroku. Oczekiwane wartości pochodzą z zatwierdzonego planu, nie z kodu napisanego przez agenta:

```ts
test('TC-01', async ({ api, plan }) => {
  const res = await step('S1', () =>
    api.post('/cart/items', { data: { sku: 'TEST-SKU-1', qty: 2 } }));
  verify('S1', 'status', res.status(), plan.expect('TC-01.S1.status'));      // 201
  verify('S1', 'body.total', (await res.json()).total,
         plan.expect('TC-01.S1.body.total'));
});
```

**Przed uruchomieniem** wygenerowane pliki przechodzą kontrole statyczne: `tsc --noEmit`, lint i sprawdzenie pokrycia (każdy krok z planu ma swoje `step()` i co najmniej jedno `verify()`). Plik, który nie przejdzie kontroli, wraca do Autora z listą błędów; po dwóch nieudanych próbach przypadek dostaje BLOCKED.

**Reguły wykonania**

- **Retry:** jedno powtórzenie przy failu. Sukces dopiero w powtórzeniu to status FLAKY, nie PASSED.
- **Healer:** po failu może poprawić wyłącznie selektory i oczekiwania czasowe, maksymalnie 2 próby. Porównanie AST blokuje każdą zmianę w asercjach (sekcja 10).
- **Równoległość:** API i web równolegle; mobile sekwencyjnie na urządzenie.
- **Przypadki mieszane:** jeden test może łączyć UI i API, np. akcja w przeglądarce, a potem sprawdzenie stanu przez API.
- **Repo testów:** Autor czyta istniejące testy i helpery, żeby trzymać się konwencji projektu. Opcjonalnie, po zakończeniu, framework otwiera PR do repo testów z nowymi przypadkami.

## 10. Warstwa weryfikacji: fail to fail

Agent nie ma możliwości ustalenia wyniku: status pochodzi z runnera, każde zdanie raportu musi mieć pokrycie w pliku evidence, a agent nie ma prawa zapisu do folderów z wynikami. Prompt „nie halucynuj” jest tylko ostatnią linią obrony; pierwsze dziewięć to kod.

| # | Warstwa | Przed czym chroni | Jak działa |
| --- | --- | --- | --- |
| 1 | Werdykt z runnera | wymyślony PASSED | Status czytany z raportu JSON runnera. Agent nie ma żadnego narzędzia do ustawienia statusu. |
| 2 | Zakaz zapisu | podmiana wyników | Hook `PreToolUse` odrzuca każdy zapis agenta do `results/`, `evidence/` i `plan.approved.yaml`. |
| 3 | Ugruntowanie planu | wymyślone wymagania | Każdy przypadek ma `source`. Cytat z biletu jest sprawdzany dosłownie w zrzucie biletu, plik z diffu musi istnieć w diffie. |
| 4 | Blokada asercji | „naprawienie” testu zmianą oczekiwań | Oczekiwane wartości czytane z zamrożonego planu. Po każdej poprawce Healera porównanie AST odrzuca zmiany w `verify()`. |
| 5 | Pokrycie planu | pominięte przypadki lub kroki | Analiza statyczna: każdy krok planu ma `step()` i `verify()`. Brak to BLOCKED, nie cisza. |
| 6 | Dziennik narzędzi | ukryte działania agenta | Hooki zapisują każde wywołanie narzędzia z argumentami i wynikiem do `journal/events.jsonl`. |
| 7 | Manifest evidence | brakujące lub podmienione pliki | SHA-256 każdego pliku zapisywany przez runner. Raport odwołuje się do plików przez hash. |
| 8 | Agent Audytor | niespójności, których reguły nie łapią | Osobny agent z czystym kontekstem dostaje plan, surowe wyniki i evidence (z obrazami). Może tylko obniżyć status do NEEDS\_REVIEW, nigdy podnieść. |
| 9 | Bramki przed publikacją | niepełny lub sprzeczny raport | Twarde reguły poniżej; liczby w raporcie liczy kod. |
| 10 | Człowiek | wszystko inne | Podgląd macierzy przed wysłaniem do Jiry, domyślnie włączony. |

**Statusy**

| Status | Znaczenie |
| --- | --- |
| PASSED | Wszystkie `verify()` przeszły za pierwszym razem i istnieje evidence każdego kroku. |
| FAILED | Co najmniej jedno `verify()` nie przeszło. Evidence zawiera oczekiwane i faktyczne wartości. |
| FLAKY | Fail, a potem sukces w powtórzeniu. Wymaga oceny człowieka. |
| BLOCKED | Test nie mógł się wykonać: środowisko, dane, kod testu nie przeszedł kontroli. |
| NOT\_RUN | Przypadek z planu, którego nie uruchomiono (np. przerwany run). |
| NEEDS\_REVIEW | Runner dał PASSED, ale Audytor lub bramka znaleźli niespójność. |

**Bramki przed publikacją (każda musi przejść)**

- Każdy przypadek z `plan.approved.yaml` ma dokładnie jeden status; hash planu zgadza się z zapisanym przy akceptacji.
- Żaden PASSED bez co najmniej jednego wykonanego `verify()` i bez evidence każdego kroku.
- Każdy FAILED ma zapisane oczekiwane i faktyczne wartości oraz evidence kroku, który padł.
- Wszystkie pliki z manifestu istnieją i mają zgodny hash.
- Skan sekretów nie znalazł żadnej wartości z rejestru sekretów.
- Podsumowanie słowne agenta jest sprawdzane automatycznie: każda liczba musi równać się wartości policzonej przez kod, a każdy wymieniony ID przypadku musi istnieć ze zgodnym statusem. Rozbieżność odrzuca tekst.

**Kanarek (opcjonalnie).** Framework uruchamia jeden krok z celowo odwróconą asercją. Musi dać FAILED; jeśli wyjdzie PASSED, test nie umie failować i całe uruchomienie dostaje NEEDS\_REVIEW.

## 11. Evidence i macierz testów

Macierz ma jeden wiersz na każdy przypadek z zatwierdzonego planu i generuje ją kod z surowych wyników, a nie agent. Przypadek, którego nie wykonano, też jest w macierzy, ze statusem NOT\_RUN albo BLOCKED.

**Przykład macierzy**

| TC | Tytuł | AC | Typ | Status | Kroki OK | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| TC-01 | Dodanie produktu zwraca 201 i przelicza sumę | AC-1 | API | PASSED | 1/1 | req/resp × 1 |
| TC-02 | Koszyk w UI pokazuje nową sumę | AC-1 | Web | FAILED | 1/2 | 2 screenshoty, wideo, trace |
| TC-03 | Limit 99 sztuk w koszyku | AC-2 | API | PASSED | 2/2 | req/resp × 2 |
| TC-04 | Dodanie do koszyka w aplikacji Android | AC-3 | Mobile | BLOCKED | 0/3 | log emulatora |

**Formaty raportu**

- `matrix.md`: podstawa komentarza w Jirze.
- `matrix.xlsx` i `matrix.csv`: do archiwum i narzędzi zarządzania testami.
- `report.html`: jeden samodzielny plik z macierzą, krokami, screenshotami, odtwarzaczem wideo i linkami do trace.

**Evidence jednego wywołania API** (wartości sekretów już zamaskowane):

```json
{
  "case": "TC-01", "step": "S1", "attempt": 1,
  "request": {
    "method": "POST", "url": "http://localhost:51234/cart/items",
    "headers": { "Authorization": "***", "Content-Type": "application/json" },
    "body": { "sku": "TEST-SKU-1", "qty": 2 }
  },
  "response": { "status": 201, "durationMs": 84, "body": { "total": 59.98 } },
  "assertions": [
    { "field": "status", "expected": 201, "actual": 201, "pass": true },
    { "field": "body.total", "expected": 59.98, "actual": 59.98, "pass": true }
  ],
  "curl": "curl -X POST http://localhost:51234/cart/items -H 'Authorization: ***' ..."
}
```

**Polityka mediów (konfigurowalna)**

- **Screenshoty:** po każdym kroku UI; przy kroku z failem dodatkowo zrzut całej strony i snapshot DOM (web) albo źródło ekranu (mobile).
- **Wideo web:** domyślnie zachowywane tylko przy failu (`retain-on-failure`); opcja `always`, jeśli chcesz dowód także dla sukcesów.
- **Wideo mobile:** nagrywane per przypadek, domyślnie zachowywane tylko przy failu.
- **Kompresja:** ffmpeg obniża rozdzielczość i bitrate przed wysyłką, żeby filmy mieściły się w limicie załączników Jiry.
- **Trace Playwright:** zachowywany przy failu; pozwala lokalnie przejść krok po kroku przez test z DOM, siecią i konsolą.

## 12. Raport do Jiry i udostępnianie filmów

Po podglądzie i akceptacji macierzy framework dodaje do biletu jeden komentarz z wynikiem i załącza evidence. Każde kolejne uruchomienie dodaje nowy komentarz, a poprzednie zostają jako historia.

**Struktura komentarza**

1. **Nagłówek:** RUN-ID, data, środowisko, wersja (SHA commita lub numer buildu), wykonawca, wersja planu.
2. **Podsumowanie:** np. „4 przypadki: 2 PASSED, 1 FAILED, 1 BLOCKED”. Liczby z kodu.
3. **Macierz:** tabela z sekcji 11.
4. **Faile:** dla każdego krok, oczekiwana i faktyczna wartość, nazwa screenshotu i filmu w załącznikach.
5. **Odtworzenie lokalne:** gotowa komenda, np. `qa evidence SHOP-482 --run 20261003-1046-k7f3 --failed`.

**Załączniki**

- `SHOP-482_20261003-1046-k7f3_evidence.zip`: pełny folder evidence z `report.html` i manifestem.
- Osobno screenshoty i filmy z faili, żeby były widoczne w Jirze bez rozpakowywania archiwum.
- Przed wysyłką framework sprawdza rozmiar pliku z limitem instancji. Za duże pliki trafiają do magazynu obiektów (S3, MinIO, Azure Blob), a w komentarzu pojawia się link z ograniczonym czasem ważności.

**Szczegóły techniczne**

- Jira Cloud: REST API v3, komentarz w formacie ADF (Atlassian Document Format), załączniki przez `POST /rest/api/3/issue/{key}/attachments` z nagłówkiem `X-Atlassian-Token: no-check`.
- Jira Data Center: REST API v2 i wiki markup. Różnice zamyka adapter.
- Identyfikator komentarza zapisywany w `run.json`, więc ponowna publikacja tego samego uruchomienia aktualizuje komentarz zamiast go dublować.
- Opcjonalnie: import wyników do Xray lub Zephyr Scale, szkic buga dla każdego FAILED (tworzony dopiero po potwierdzeniu przez użytkownika), zmiana statusu biletu.

**Film z faila dla użytkownika**

- `qa evidence SHOP-482` otwiera `report.html` ostatniego uruchomienia w przeglądarce, z wbudowanym odtwarzaczem.
- `qa evidence SHOP-482 --failed` otwiera od razu filmy z faili w systemowym odtwarzaczu.
- `qa evidence SHOP-482 --trace TC-02` otwiera trace w Playwright Trace Viewer: krok po kroku, z DOM, siecią i konsolą.
- Jeśli testy szły na CI albo na innej maszynie, `qa pull SHOP-482 --run <id>` pobiera evidence z załączników Jiry lub z magazynu do lokalnego workspace, a potem działa jak wyżej.
- Każdy fail w komentarzu Jiry ma też bezpośredni załącznik z filmem, więc osoba bez frameworka obejrzy go w przeglądarce.

## 13. Generyczność: podpięcie pod dowolny projekt

Framework to pakiet npm z komendą `qa`. Projekt podłącza się przez folder `.qa/` w swoim repozytorium, a wszystko, co różni projekty, zamyka się w konfiguracji i w wymiennych adapterach.

**Folder `.qa/` w projekcie**

```text
.qa/
  qa.project.yaml        # serwisy, repo, Jira, typy testów, polityki
  envs/                  # local.yaml, staging.yaml (bez sekretów)
  auth/                  # helpery logowania per alias konta
  hooks/                 # seed danych, przygotowanie i sprzątanie środowiska
  knowledge/             # wiedza dla agentów: słownik domeny, konwencje, opis kont testowych
```

**Przykład `qa.project.yaml`**

```yaml
project: shop
jira:
  project_key: SHOP
  acceptance_criteria_field: customfield_10042   # pole z AC, jeśli jest osobne
code_hosts:
  github: { base_url: https://api.github.com,       token: "secret://env/GITHUB_TOKEN" }
  gitlab: { base_url: https://gitlab.acme.local/api, token: "secret://env/GITLAB_TOKEN" }
repos:
  backend: { host: gitlab, path: acme/shop-backend, default_ref: main }
  web:     { host: github, path: acme/shop-web,     default_ref: main }
  tests:   { host: github, path: acme/shop-tests,   path_api: api/, path_web: e2e/ }
change_discovery: [jira_dev_panel, ticket_key_in_branch, ticket_key_in_title]
environments:
  default: staging              # gdy nie podano --env ani --build
  version_endpoint: /version    # do porównania wdrożonego SHA ze zmianą
api:
  openapi: repos/backend/docs/openapi.yaml
services:
  postgres:      { compose_service: db, health: { port: 5432 } }
  orders-api:    { compose_service: orders, health: { http: /health }, env: { ... } }
  payments-stub: { stub: wiremock, mappings: .qa/stubs/payments }
  web:           { compose_service: web, health: { http: / } }
mobile:
  android: { app_artifact: "ci://web/{sha}/app-debug.apk", device: emulator:Pixel_8_API_35 }
models: { roles: { author: company/strong, summary: local/<model> } }   # pełna składnia w sekcji 4
test_types: [api, web, mobile]
secrets: { provider: env }
cleanup: { policy: on_success, keep_last: 5, max_age_days: 14 }
publish: { jira_comment: true, attach_zip: true, review_before_publish: true, pr_mr_comment: false }
```

**Interfejsy adapterów**

| Interfejs | Odpowiada za | Na start | Później |
| --- | --- | --- | --- |
| TicketSource | bilet, AC, komentarze, powiązania | Jira Cloud | Jira Data Center, Linear, GitHub Issues |
| CodeHost | repozytoria, PR/MR, diff, komentarze review, artefakty CI | GitHub i GitLab (także self-hosted) | Bitbucket, Azure DevOps |
| ModelProvider | dostęp do LLM dla każdej roli agenta | Anthropic, OpenAI, Google, Ollama, endpointy zgodne z OpenAI (LiteLLM) | Bedrock, Azure, Vertex i inni dostawcy z AI SDK |
| EnvProvider | start, health check, stop | zdalne, Docker Compose | Kubernetes (kind), własny skrypt, farma urządzeń |
| SecretProvider | wartości sekretów | zmienne, `.env.local` | 1Password, Vault, AWS/GCP Secret Manager |
| Runner | wykonanie i evidence | API, web | Android, iOS |
| EvidenceStore | przechowanie plików | dysk lokalny | S3, MinIO, Azure Blob |
| Publisher | publikacja wyniku | komentarz w Jirze | Xray, Zephyr Scale, Slack |

**Onboarding nowego projektu**

1. `qa init`: interaktywny kreator tworzy `.qa/` na podstawie pytań i wykrytego `docker-compose.yml`.
2. `qa doctor`: sprawdza dostęp do Jiry i repo, Dockera, emulatorów, sekretów i modelu.
3. `qa env up --build`: test samego startu środowiska, bez agentów.
4. Pierwszy bilet na sucho: `qa test SHOP-1 --dry-run` (plan i specy, bez publikacji).

**Dodatkowy interfejs (opcjonalnie):** ten sam rdzeń może być udostępniony jako plugin Claude Code ze skillami `/qa-plan`, `/qa-run`, `/qa-evidence`, dla osób, które wolą pracę w czacie niż w terminalu.

### Uruchamianie w CI/CD

Ten sam CLI działa w pipeline bez zmian: framework dostarcza gotową GitHub Action, szablon GitLab CI i obraz Dockera (Node, przeglądarki Playwright, git) dla pozostałych systemów, np. Jenkinsa. Akceptacja planu zostaje człowiekowi także w CI; zmienia się tylko to, gdzie się jej dokonuje.

**Kiedy pipeline uruchamia framework**

- **Pull request lub merge request** z etykietą `qa-agent`. Klucz biletu framework bierze z nazwy brancha albo tytułu PR/MR.
- **Zmiana statusu biletu w Jirze**, np. na „Ready for QA”: webhook Jiry albo automatyzacja Jiry uruchamia pipeline.
- **Ręcznie** z interfejsu CI, z parametrami: bilet, środowisko, tryb.

**Akceptacja planu w pipeline**

1. Job `qa-plan` tworzy plan i publikuje go jako komentarz w PR/MR i w Jirze oraz jako artefakt pipeline.
2. Recenzent czyta plan. Poprawki zgłasza komentarzem `/qa revise <opis>`, co uruchamia `qa-plan` ponownie z nową wersją.
3. Akceptacja uruchamia job `qa-run`: w GitHub Actions przez środowisko z wymaganymi recenzentami, w GitLab CI przez job ręczny (`when: manual`), albo komentarzem `/qa approve`.
4. Ponowne uruchomienie po nowych commitach używa już zatwierdzonego planu, o ile bilet się nie zmienił. Nowy plan nigdy nie jest akceptowany automatycznie.

```yaml
# GitHub Actions
jobs:
  qa-plan:
    if: contains(github.event.pull_request.labels.*.name, 'qa-agent')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: acme/qa-agent-action@v1
        with: { command: plan }
        env: { JIRA_TOKEN: "${{ secrets.JIRA_TOKEN }}", LITELLM_KEY: "${{ secrets.LITELLM_KEY }}" }
  qa-run:
    needs: qa-plan
    environment: qa-approval      # wymaga zatwierdzenia przez wskazane osoby
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: acme/qa-agent-action@v1
        with: { command: run, env: build }
```

```yaml
# GitLab CI
include:
  - remote: https://example.com/qa-agent/qa-agent.gitlab-ci.yml
qa-plan:
  extends: .qa-plan
  rules: [{ if: '$CI_MERGE_REQUEST_LABELS =~ /qa-agent/' }]
qa-run:
  extends: .qa-run
  needs: [qa-plan]
  when: manual                   # uruchomienie = akceptacja planu
  variables: { QA_ENV: "$CI_ENVIRONMENT_URL" }
```

**Co framework oddaje pipeline'owi**

| Wynik | Znaczenie |
| --- | --- |
| kod wyjścia 0 | wszystkie przypadki PASSED |
| kod wyjścia 1 | co najmniej jeden FAILED |
| kod wyjścia 2 | brak FAILED, ale są BLOCKED, FLAKY albo NEEDS\_REVIEW |
| kod wyjścia 3 | błąd samego frameworka lub konfiguracji |
| raport JUnit XML | wyniki widoczne w zakładce testów GitHub i GitLab |
| artefakty | zip z evidence i `report.html` dołączone do pipeline |
| status check i komentarz w PR/MR | macierz i link do raportu przy zmianie kodu |

**Praktyczne zasady**

- **Środowisko w CI:** `--env` wskazuje na środowisko wdrożone przez pipeline dla tego PR/MR (review app, preview deploy), a `--build` stawia aplikację na runnerze z Dockerem.
- **Sekrety:** z magazynu CI (GitHub Secrets, zamaskowane zmienne GitLab) przez dostawcę `secrets-env` albo przez OIDC do menedżera sekretów w chmurze.
- **Modele:** klucze API albo firmowa bramka LiteLLM; Ollama na własnym runnerze z GPU.
- **Mobile:** emulator Androida wymaga runnera z KVM; iOS wymaga runnerów z macOS albo farmy urządzeń.
- **Koszt i czas:** uruchamianie tylko z etykietą lub przy zmianie wskazanych ścieżek, limit czasu i budżet tokenów na uruchomienie, cache mirrorów git i przeglądarek.
- **Workspace** w CI jest jednorazowy, więc retencja nie ma znaczenia; evidence trafia do artefaktów pipeline i do Jiry.
- **Wdrażanie stopniowe:** na start wynik jest informacyjny i nie blokuje merge. Wymaganym sprawdzeniem staje się dopiero wtedy, gdy odsetek fałszywych FAILED jest niski.

## 14. Repozytorium, testy frameworka i skille agentów

Monorepo w pnpm, w którym rdzeń nie zależy od żadnego konkretnego narzędzia: Jira, GitHub, Docker czy Appium są tylko pakietami adapterów.

```text
qa-agent/
  CLAUDE.md            # zasady architektury i komendy dla agentów budujących framework
  .claude/
    skills/            # tdd-feature, new-adapter, adversarial-test, demo-bug
    agents/            # architecture-reviewer, security-reviewer
  packages/
    core/              # maszyna stanów, run.json, workspace, ładowanie konfiguracji, schematy Zod
    cli/               # komenda qa: plan, approve, run, test, evidence, clean, gc, init, doctor, bench
    agents/            # pętla agenta, definicje i prompty: analyst, planner, author, healer, auditor
    models/            # ModelProvider: Anthropic, OpenAI, Ollama, OpenAI-compatible (LiteLLM)
    guard/             # strażnik narzędzi: zakazy zapisu, allowlista URL, dziennik
    steps/             # @qa/steps: step(), verify(), maskowanie, zapis evidence
    verifier/          # bramki, porównanie AST asercji, pokrycie planu, skan sekretów
    report/            # macierz (md/csv/xlsx), report.html, komentarz ADF
    adapters/          # ticket-*, codehost-*, env-*, secrets-*, runner-*, evidence-*, publish-*
  tests/
    contract/          # adaptery na nagranych odpowiedziach API
    adversarial/       # scenariusze kłamiącego agenta
    e2e/               # pełny przepływ na demo-shop
    golden/            # wzorcowe matrix.md, komentarz ADF, report.html
  fixtures/            # nagrane odpowiedzi Jira, GitHub, GitLab, modeli (bez sekretów)
  schemas/             # JSON Schema: plan, wyniki, manifest, konfiguracja projektu
  templates/           # szablony .qa/, plan.md, report.html
  examples/
    demo-shop/         # aplikacja z celowymi błędami i własnym .qa/
  docs/
```

### Testowanie samego frameworka

Każda funkcja frameworka ma testy, zanim zacznie działać: najpierw test, potem kod. Testy uruchamiane przy każdym commicie nigdy nie wołają prawdziwego modelu ani prawdziwej Jiry, więc są szybkie i deterministyczne. Jakość pracy prawdziwych modeli mierzy osobna, nocna ewaluacja.

| Poziom | Co sprawdza | Narzędzia | Kiedy |
| --- | --- | --- | --- |
| Jednostkowe | schematy, scalanie konfiguracji, maskowanie sekretów, RUN-ID, bramki, porównanie AST asercji, liczenie macierzy | Vitest | każdy commit |
| Kontraktowe adapterów | Jira, GitHub, GitLab, LiteLLM, Ollama na nagranych odpowiedziach | Vitest + MSW, nagrane fixtures bez sekretów | każdy commit; nocą na prawdziwych kontach testowych |
| Agent z atrapą modelu | pętla agenta, strażnik narzędzi, ponowienia przy złym schemacie, limity tur | mock modelu z AI SDK (`ai/test`), skryptowane odpowiedzi | każdy commit |
| Testy przeciwnika | atrapa kłamiącego agenta próbuje zapisać do `results/`, zmienić asercję, wymyślić cytat z biletu, przemycić sekret do evidence | jak wyżej | każdy commit, blokują merge |
| End-to-end | pełny przepływ na demo-shop: plan, testy, evidence, komentarz do atrapy Jiry | Docker Compose, WireMock | każdy pull request |
| Złote pliki | `matrix.md`, komentarz ADF i `report.html` zgodne z zatwierdzonym wzorcem | snapshoty Vitest | każdy commit |
| Ewaluacja modeli | jakość planów i testów na prawdziwych modelach, wykrywanie celowych błędów demo-shop | `qa bench` | nocą i przed wydaniem; trend, nie blokuje PR |

**Zasady**

- **Ochrona powstaje po teście przeciwnika.** Dla każdej bramki i reguły strażnika najpierw powstaje scenariusz, w którym atrapa agenta próbuje ją obejść, i dopiero potem kod, który ją blokuje.
- **Demo-shop jest zestawem regresji.** Każdy celowy błąd w aplikacji demo ma oczekiwany wynik FAILED. Jeśli zmiana w promptach albo bramkach sprawi, że błąd przejdzie jako PASSED, CI się zatrzyma.
- **Wymagane sprawdzenia w CI:** testy, `tsc`, lint i skan sekretów w fixtures są obowiązkowe przed merge do gałęzi głównej.

### Skille i instrukcje dla agentów budujących framework

Warto je mieć, ale z umiarem: jeden plik z zasadami, cztery skille dla procedur, które będą się powtarzać, i dwóch recenzentów. Kolejny skill powstaje dopiero wtedy, gdy jakaś procedura powtórzy się drugi raz. Skille przyspieszają pracę agenta, ale gwarancje dają testy i wymagane sprawdzenia w CI.

**`CLAUDE.md` (lub `AGENTS.md` dla innych narzędzi)** zawiera zasady nienaruszalne: agent nigdy nie ustala statusu testu, do `results/` pisze tylko runner, testy nie wołają prawdziwego modelu, każda nowa bramka ma test przeciwnika, sekrety tylko przez `SecretProvider`. Do tego komendy (`pnpm test`, `pnpm test:e2e`) i mapa pakietów.

| Skill | Kiedy | Co robi |
| --- | --- | --- |
| `tdd-feature` | każda nowa funkcja | test, który nie przechodzi, potem implementacja, zielone testy, refaktor; nie pozwala uznać zadania za skończone bez zielonego CI |
| `new-adapter` | nowy Jira Data Center, Bitbucket, dostawca sekretów lub modelu | szkielet implementacji interfejsu, testy kontraktowe, nagranie fixtures z wyczyszczeniem sekretów, wpis w dokumentacji |
| `adversarial-test` | nowa bramka lub reguła strażnika | scenariusz atrapy kłamiącego agenta i oczekiwany efekt: blokada albo NEEDS\_REVIEW |
| `demo-bug` | rozbudowa demo-shop | celowy błąd w aplikacji demo, oczekiwany FAILED w regresji i nowy przypadek w `qa bench` |

**Subagenci-recenzenci** z czystym kontekstem: `architecture-reviewer` sprawdza zmiany pod kątem zasad z `CLAUDE.md`, a `security-reviewer` pilnuje sekretów, maskowania, allowlisty i uprawnień narzędzi. Mają dostęp tylko do odczytu, tak jak Audytor w samym frameworku.

## 15. Roadmapa wdrożenia

Kolejność jest ustawiona tak, żeby jak najwcześniej mieć działający przepływ od biletu do komentarza w Jirze dla najprostszego przypadku (API na istniejącym środowisku), a dopiero potem dokładać trudniejsze elementy. Bramki weryfikacji wchodzą razem z pierwszym wykonaniem, nie na końcu. Etap jest gotowy dopiero wtedy, gdy jego testy (sekcja 14) przechodzą w CI, a powstały przed kodem funkcji. Etap 1 obejmuje więc też plik CLAUDE.md, skill tdd-feature i pipeline CI.

1. **Fundament.** Monorepo, CLI, schemat `qa.project.yaml`, workspace z RUN-ID, `run.json`, odczyt biletu z Jiry, adaptery GitHub i GitLab, wykrywanie PR/MR i pobieranie repozytoriów ze zmianą.
   - *Gotowe, gdy:* `qa fetch SHOP-482` tworzy folder uruchomienia ze zrzutem biletu oraz kopiami roboczymi i diffem zmiany, sprawdzone na repozytorium z GitHuba i z GitLaba.
2. **Plan i akceptacja.** Warstwa modeli z co najmniej dwoma dostawcami (chmurowym i Ollamą), agenci Analityk i Planista, schemat planu, `plan.md`, pętla poprawek, zamrożenie hashem, kontrola cytatów `source`.
   - *Gotowe, gdy:* plany dla 5 prawdziwych biletów zostały ocenione przez Ciebie jako użyteczne bez dużych poprawek.
3. **API na istniejącym środowisku.** Agent Autor, `@qa/steps`, runner API, evidence req/resp, kontrole statyczne, bramki deterministyczne, macierz i `report.html`.
   - *Gotowe, gdy:* bilet API przechodzi od planu do raportu lokalnie, a celowo zepsuty endpoint daje FAILED.
4. **Publikacja w Jirze.** Komentarz ADF, załączniki, podgląd przed wysyłką, skan sekretów.
   - *Gotowe, gdy:* komentarz i zip z evidence pojawiają się w testowym bilecie, a sekret wstrzyknięty do odpowiedzi blokuje publikację.
5. **UI web.** Runner Playwright, Playwright MCP do rekonesansu, screenshoty, wideo, trace, Healer z blokadą asercji, `qa evidence`.
   - *Gotowe, gdy:* fail UI ma film dostępny lokalnie jedną komendą, a Healer nie jest w stanie zmienić oczekiwanej wartości.
6. **Środowisko lokalne z repozytorium.** Cache git i worktree, warstwy zmiennych, dostawca sekretów, compose z nakładką, health checki, seed, sprzątanie po etykietach, retencja.
   - *Gotowe, gdy:* `qa test SHOP-482 --build` stawia aplikację od zera, a `qa gc` nie zostawia żadnych kontenerów.
7. **Agent Audytor i kanarek.** Niezależna weryfikacja z czystym kontekstem, status NEEDS\_REVIEW.
   - *Gotowe, gdy:* na zestawie przypadków z demo-shop Audytor wyłapuje podsunięte niespójności.
8. **Mobile.** Android na emulatorze (Appium + WebdriverIO, appium-mcp), nagrania ekranu, potem iOS na macOS lub przez farmę urządzeń.
   - *Gotowe, gdy:* bilet mobilny ma pełną macierz i film z faila.
9. **Generalizacja.** Podpięcie drugiego, innego projektu wyłącznie przez `.qa/`, `qa init`, `qa doctor`, dokumentacja.
   - *Gotowe, gdy:* drugi projekt działa bez zmian w kodzie frameworka.
10. **CI/CD i tryb bezobsługowy.** GitHub Action, szablon GitLab CI i obraz Dockera, akceptacja planu w pipeline, kody wyjścia i raport JUnit, uruchamianie po zmianie statusu biletu, magazyn obiektów na duże filmy (sekcja 13). Gotowe, gdy PR z etykietą qa-agent przechodzi cały przepływ w GitHub Actions i w GitLab CI.

## 16. Ryzyka i otwarte pytania

Największe ryzyko to nie agenci, tylko środowisko lokalne: aplikacja z wieloma zależnościami może nie dać się postawić w całości, więc od początku trzeba planować stuby.

| Ryzyko | Skutek | Jak ograniczyć |
| --- | --- | --- |
| Złożone środowisko lokalne | testy wiecznie BLOCKED | stuby zależności, tryb zdalny jako domyślny, gotowe artefakty z CI zamiast budowania |
| Wyciek sekretów do Jiry | incydent bezpieczeństwa | maskowanie przy zapisie, skan przed publikacją, konta testowe przez aliasy |
| Agent uruchamia coś szkodliwego | utrata danych, testy na produkcji | hook `PreToolUse`: allowlista URL i komend, brak dostępu do produkcji, uruchamianie w kontenerze |
| Niedeterminizm modelu | różne plany dla tego samego biletu | schematy Zod, zamrożony plan, przykłady w `.qa/knowledge/` |
| Niestabilne testy UI i mobile | fałszywe FAILED | retry ze statusem FLAKY, Healer tylko dla selektorów, stabilne `data-testid` w aplikacji |
| Koszt tokenów przy dużych diffach | wolno i drogo | streszczenie diffu do plików istotnych dla biletu, cache kontekstu repo |
| Duże filmy | odrzucone załączniki | kompresja ffmpeg, zachowanie tylko przy failu, magazyn obiektów |
| iOS bez macOS | brak testów iOS | farma urządzeń jako osobny dostawca środowiska |

**Pytania do Ciebie, które zmieniają plan**

- [ ] Jira Cloud czy Data Center? Czy AC są w opisie, czy w osobnym polu?
- [ ] Czy GitHub i GitLab są w chmurze, czy self-hosted? Czy PR/MR są linkowane do biletów (panel Development w Jirze)?
- [ ] Czy używacie Xray lub Zephyr, czy wynik ma żyć tylko w komentarzu?
- [ ] Jak dziś uruchamiacie aplikację lokalnie: Docker Compose, skrypty, Kubernetes?
- [ ] Mobile: natywne (Kotlin/Swift), React Native czy Flutter? Emulatory lokalne czy farma urządzeń?
- [ ] Gdzie trzymacie sekrety (Vault, 1Password, chmura, pliki)?
- [ ] Jakie modele są dostępne: chmurowi dostawcy, firmowa bramka LiteLLM, modele lokalne przez Ollamę? Jaki sprzęt GPU jest do dyspozycji dla modeli lokalnych?
- [ ] Jaki język zna zespół, który będzie utrzymywał framework (potwierdzenie TypeScript)?

**Źródła**

- [Claude Agent SDK: przegląd](https://code.claude.com/docs/en/agent-sdk.md) i [hooki](https://platform.claude.com/docs/en/agent-sdk/hooks)
- [appium/appium-mcp](https://github.com/appium/appium-mcp)
- Przykłady podobnych podejść open source: [vc-mcp-testing-module](https://github.com/virtocommerce/vc-mcp-testing-module), [agentic-test-automation](https://github.com/jpucic00/agentic-test-automation), [jira-testplan-bot](https://github.com/ramtey/jira-testplan-bot)
