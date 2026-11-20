<!-- Raport z 2026-11-20, przygotowany przy porównaniu z Next DevTools MCP. Stan wiedzy na ten dzień; sprawdzać przy nowych wersjach Next. -->

> **Weryfikacja na prawdziwym Next 16.4.0 (macOS, Node 26.12, monorepo z dwiema aplikacjami, 2026-11-20).** Hipotezy z tego raportu:
> - wykrywanie przez `next-devtools-mcp` przy `--inspect`: **brak kolizji**, `nextjs_index` bez portu znalazł obie aplikacje (3101 i 3102);
> - nagłówki `x-nextjs-request-id` / `x-nextjs-html-request-id`: `get_request_insights({ requestId })` zwrócił to samo żądanie (`route: /seq`, `htmlRequestId` zgodny) co nasze `next_request_id`, więc złączenie działa;
> - żądania `/_next/mcp` nie pojawiły się jako żądania stron.
# node-outbound-inspector a MCP w Next.js: porównanie

_Stan na 2026-11-20. Sprawdzone wersje: Next.js **v16.4.6** (najnowszy stabilny tag, 2026-11-09), gałąź `canary` (**v16.5.0-canary.57**, commit z 2026-11-19), `next-devtools-mcp` **0.4.1** (HEAD repozytorium z 2026-09-14). Nasze narzędzie: 0.5.0._

**Oznaczenia:**

| Znak | Znaczenie |
|---|---|
| **[D]** | fakt z dokumentacji lub bloga nextjs.org albo z README `next-devtools-mcp` |
| **[K]** | fakt z kodu źródłowego (`vercel/next.js` v16.4.6 albo canary, `vercel/next-devtools-mcp` 0.4.1) |
| **[W]** | wniosek autora raportu |
| **[H]** | hipoteza do sprawdzenia na prawdziwym monorepo |

**Ograniczenia tej analizy.** Nie uruchamiałem Next.js. Rejestr npm nie był dostępny, więc wersje ustaliłem z tagów git i `package.json` w repozytoriach, a nie z `npm view`. Kod czytałem bezpośrednio z repozytoriów.

---

## TL;DR

- Next.js MCP **ma** jedno narzędzie, które dotyka wychodzących zapytań serwera: `get_request_insights` (od 16.3, wymaga `experimental.requestInsights`). Dla każdego `fetch` wykonanego w kontekście żądania App Routera podaje URL, metodę, status, czas startu i trwania, **status cache Next** i powiązanie z żądaniem strony (`requestId`, `htmlRequestId`, `route`) **[K]**.
- Nie ma w nim nagłówków, treści, `node:http` (axios, got, SOAP, klienty SDK), zapytań spoza kontekstu żądania, analizy waterfall, oszczędności z `Promise.all`, duplikatów ani wolnych zapytań. Nie ma też limitu rozmiaru odpowiedzi (w 16.4.6) **[K]**.
- **Nasze narzędzie nie dubluje Next MCP** **[W]**. Pokrywa się z nim w części „lista `fetch` z czasami i przypisaniem do strony”. Poza tym narzędzia się uzupełniają: Next widzi framework (trasy, cache, błędy, kompilację, spany renderowania), my widzimy sieć (nagłówki, treści, `node:http`, analizę osi czasu).
- Najtańsza integracja: hak czyta nagłówki `x-nextjs-request-id` i `x-nextjs-html-request-id`, które przeglądarka wysyła w dev przy nawigacjach RSC i Server Actions, i zapisuje je przy żądaniu strony. Wtedy agent łączy nasze wyniki z `get_request_insights({ requestId | htmlRequestId })` dokładnie, bez dopasowywania po czasie **[K → W]**.
- Ryzyko w monorepo: `next-devtools-mcp` sam znajduje tylko serwery na portach 3000–3010 albo proces `next-server`, biorąc **pierwszy** port, na którym ten proces nasłuchuje. Nasz `--inspect=<port>` dokłada drugi port w tym samym procesie **[K]**, więc wykrywanie może trafić w port inspektora **[H]**. Obejście: porty aplikacji z zakresu 3000–3010 albo jawny `port` w `nextjs_index` i `nextjs_call`.

---

## 1. Co udostępnia MCP w Next.js

### 1.1. Dwie warstwy

1. **Endpoint `/_next/mcp`** wbudowany w `next dev` (Next ≥ 16), domyślnie włączony; wyłącza go `experimental.mcpServer: false` **[D]**. Transport to Streamable HTTP, bezstanowy (`sessionIdGenerator: undefined`), z limitem treści żądania 1 MB **[K]**. Działa w procesie serwera aplikacji.
2. **Pakiet `next-devtools-mcp`** (stdio) to „cienki łącznik”: wykrywa działające serwery dev i przekazuje wywołania do ich `/_next/mcp` **[D]**. Skille, np. `next-dev-loop`, wołają `/_next/mcp` bezpośrednio, bez tego pakietu **[D]**.

### 1.2. Narzędzia `next-devtools-mcp` 0.4.1 [D, K]

| Narzędzie | Co robi |
|---|---|
| `nextjs_index` | Wykrywa serwery dev i listuje ich narzędzia (port, PID, URL, schematy). Opcjonalny `port`, gdy wykrywanie zawiedzie. |
| `nextjs_call` | Woła narzędzie na serwerze: `port`, `toolName`, `args`. Wynik w JSON z `success`. Limit czasu 60 s. |
| `nextjs_docs` | Bramka: wskazuje dokumentację dołączoną do pakietu (`node_modules/next/dist/docs/`), niczego nie pobiera. |
| `browser_eval` | Bramka: wskazuje CLI `agent-browser`, sama nie steruje przeglądarką. |

Od 0.4.0 **usunięte** są: `init`, `upgrade_nextjs_16`, `enable_cache_components`, prompty i zasoby `cache-components://`, `nextjs16://`, `nextjs-fundamentals://`. Upgrade i Cache Components są teraz skillami (`next-cache-components-adoption` i inne) **[D]**.

### 1.3. Narzędzia endpointu `/_next/mcp` (v16.4.6)

| Narzędzie | Co zwraca | Od wersji [K] |
|---|---|---|
| `get_errors` | Błędy: `next.config`, runtime w przeglądarce, błędy budowania ze stosem po mapach źródeł. Wymaga otwartej strony. | 16.0 |
| `get_logs` | **Tylko ścieżkę** do `{distDir}/logs/next-development.log` (konsola przeglądarki i wyjście serwera); agent czyta plik sam. | 16.0 |
| `get_page_metadata` | Metadane tego, co składa się na render bieżącej strony. Wymaga otwartej strony. | 16.0 |
| `get_project_metadata` | Ścieżka projektu i URL serwera dev. | 16.0 |
| `get_server_action_by_id` | ID Server Action → plik źródłowy i nazwa eksportu. | 16.0 |
| `get_routes` | Trasy z systemu plików (`appRouter`, `pagesRouter`), segmenty dynamiczne jako wzorce. | 16.1 |
| `get_compilation_issues` | Błędy kompilacji całego grafu modułów. **Tylko Turbopack.** | 16.3 |
| `compile_route` | Kompilacja jednej trasy bez żądania HTTP. **Tylko Turbopack.** | 16.3 |
| `get_request_insights` | Osie czasu żądań App Routera, `fetch` serwera, zachowanie cache. **Wymaga `experimental.requestInsights`.** | 16.3 |

Źródła: [D] lista i opisy w dokumentacji MCP; [K] katalog `packages/next/src/server/mcp/tools/` w tagach v16.0.0 … v16.4.6. Na `canary` nie ma nowych narzędzi, zmienia się tylko `get_request_insights` (punkt 2.2) **[K]**.

**Nie ma** narzędzi do: logów `fetch` jako danych, OpenTelemetry/eksportu trace'ów, nagłówków ani treści zapytań, `node:http`, Edge **[K]**.

---

## 2. Czy Next pokazuje wychodzące zapytania serwera

### 2.1. `get_request_insights` w v16.4.6: szczegóły z kodu [K]

- **Źródło danych:** lokalny rejestrator spanów (`lib/trace/local-span-recorder.ts`, `request-insights.ts`) działa bez kolektora OTEL. Włącza go `experimental.requestInsights: true`, tylko w `next dev` (zmienne `__NEXT_DEV_SERVER` i `__NEXT_REQUEST_INSIGHTS`). Komentarz w `config-shared.ts` mówi, że flaga pokazuje też Request Insights w Next DevTools (wskaźnik dev). W dokumentacji v16.4.6 flaga występuje tylko w `guides/mcp` **[D]**.
- **Co jest zapytaniem:** wyłącznie `fetch` opakowany przez Next (`patch-fetch.ts`), czyli span `AppRender.fetch` albo metryka `trackFetchMetric`. Metryka powstaje tylko wtedy, gdy istnieje `workStore` (render, Route Handler, Server Action) i zapytanie nie jest wewnętrzne. `fetch` bez `workStore` idzie prosto do oryginału, bez metryki. **`node:http` nie ma wcale.**
- **Pola `fetches[]`:** `url` (bez danych logowania, parametry o nazwach sekretów zamienione na `redacted`), `method`, `statusCode`, `startTime`, `durationMs`, `cacheStatus` (`hit`, `miss`, `skip`, `hmr`), `cacheReason`, `index`. **Nie ma nagłówków ani treści.** Atrybuty spanów są filtrowane do białej listy (`http.*`, `net.peer.*`, `next.*`).
- **Czas:** `durationMs` liczony jest od startu do rozwiązania `originFetch` (`.then`), czyli **do nagłówków odpowiedzi**, nie do końca treści.
- **Błędy:** odrzucony `fetch` (błąd sieci) nie trafia do metryki. Może wystąpić tylko jako span ze statusem `error`, co jest wnioskiem z kodu, niesprawdzonym **[H]**. Kody 4xx i 5xx są w `statusCode`.
- **Przypisanie do strony:** `requestId`, `htmlRequestId` (wiąże żądania RSC i Server Actions z dokumentem HTML), `route` (wzorzec trasy), `url`, `kind`, `status`. Spany mają `traceId`, `spanId` i `parentSpanId`. Przy aktywnym OTel `traceId` pochodzi z prawdziwego spanu OTel, bez niego jest lokalnym licznikiem (`tracer.ts`, `local-span-recorder.ts`).
- **Identyfikatory:** serwer bierze `requestId` z nagłówka `x-nextjs-request-id`, a gdy go brak, losuje go (`nanoid`). `htmlRequestId` pochodzi z `x-nextjs-html-request-id` (`base-server.ts`). W dev przeglądarka wysyła oba nagłówki przy nawigacjach RSC i Server Actions, a dokument HTML osadza `self.__next_r` z identyfikatorem żądania HTML (`fetch-server-response.ts`, `server-action-reducer.ts`, `app-render.tsx`).
- **Retencja i rozmiar:** w pamięci jest 100 ostatnich żądań. Wynik to `JSON.stringify(…, null, 2)` wszystkich pasujących żądań ze **wszystkimi spanami**, bez limitu rozmiaru i bez stronicowania. Filtry: tylko `requestId` i `htmlRequestId`.
- **Analiza:** brak. Nie ma werdyktu sekwencyjne/równoległe, szacunku oszczędności, duplikatów ani wolnych zapytań. Agent sam wnioskuje z `startTime` i `durationMs`.

### 2.2. `get_request_insights` na canary (16.5, jeszcze niewydane) [K]

- Bez filtrów zwraca **podsumowanie 20 ostatnich żądań** (`spanCount`, `fetchCount`, `statusCode`, `hasError`, `cacheStatuses`, `isRsc`, `hasProxyActivity`) ze wskazówką „podaj `requestId`”.
- Z `requestId` albo `htmlRequestId` czyta też **dziennik historii**, czyli żądania, które wypadły z okna w pamięci. Dla `htmlRequestId` są limity: 100 żądań i 1 MB.
- Dochodzą pola `source` (page, api, image, asset) i `proxyStatus`.
- Kształt `RequestInsightFetch` się **nie zmienia**: nadal bez nagłówków, treści i `node:http`.
- **[W]** Next zmierza w stronę „mniejszy wynik, szczegóły na żądanie”, czyli tego samego kontraktu co nasz ADR 0008. Nie zmierza w stronę danych sieciowych.

### 2.3. Inne źródła w Next

| Mechanizm | Co daje | Dla agenta |
|---|---|---|
| `logging.fetches` w `next.config` | Linia w terminalu na każdy `fetch`: metoda, URL (pełny z `fullUrl: true`), status, czas, status cache i powód **[D, K: `log-requests.ts`]** | Tekst w terminalu. Czy trafia do `next-development.log` (`get_logs`)? Plik zasila `handleLog` z wpisów konsoli **[K]**, a linie `fetch` idą osobną drogą (`writeLine`), więc raczej nie **[H]**. |
| Request Insights w Next DevTools | Panel w nakładce dev (komentarz w `config-shared.ts`) **[K]** | Dla człowieka. Te same dane co `get_request_insights`. |
| `.next/trace` | Spany budowania i `handle-request` z URL żądania przychodzącego (`next-dev-server.ts`) **[K]** | Brak `fetch` wychodzących. |
| OpenTelemetry (`@vercel/otel`) | Spany `AppRender.fetch` z `http.url`, `http.method`, `http.status_code`, `net.peer.*` **[K]** | Wymaga kolektora (np. Jaeger). Brak treści i nagłówków; `node:http` tylko z dodatkową instrumentacją. |
| `get_page_metadata`, segment explorer | Struktura renderu strony **[D]** | Nic o sieci. |

**Odpowiedź na pytanie 2:** tylko `get_request_insights` (i ten sam mechanizm w panelu DevTools) pokazuje wychodzące `fetch` z czasami, kolejnością (przez `startTime` i `index`) i przypisaniem do żądania strony. Żaden mechanizm Next nie pokazuje nagłówków, treści ani `node:http` **[K]**.

---

## 3. Monorepo i wiele aplikacji naraz

- **Endpoint:** każda instancja `next dev` ma własny `/_next/mcp` na własnym porcie HTTP **[D]**.
- **Wykrywanie w `next-devtools-mcp`** (`nextjs-runtime-manager.ts`) **[K]**:
  1. sonda `POST /_next/mcp` (`tools/list`) na portach **3000–3010** (http, potem https), host `localhost` albo `NEXT_DEVTOOLS_HOST`;
  2. procesy o nazwie `next-server` (macOS, Linux; na Windows linia poleceń `node`) i **pierwszy** port nasłuchu procesu z `pid-port`, a awaryjnie z `ss` albo `netstat`; potem weryfikacja sondą.
  3. Wynik `nextjs_index` to port, PID i URL, **bez nazwy aplikacji**. Nazwę i katalog trzeba wyciągnąć z `get_project_metadata` każdej instancji.
- **Ryzyko z naszym `--inspect`** **[H]**: `next dev --inspect=<port>` uruchamia inspektor w tym samym procesie serwera. Proces nasłuchuje wtedy na dwóch portach (HTTP i inspektor), a krok 2 bierze pierwszy z nich w nieokreślonej kolejności. Jeśli to będzie port inspektora, sonda zawiedzie i aplikacja zniknie z `nextjs_index`. Nasz przykład (`3101`, `3102`) leży poza zakresem kroku 1, więc zależy wyłącznie od kroku 2. Do sprawdzenia na prawdziwym monorepo. Obejścia: porty aplikacji z 3000–3010, `nextjs_index({ port })` i `nextjs_call({ port })` z jawnym portem, porty wpisane do `AGENTS.md`/`CLAUDE.md`.
- **Nasze narzędzie:** skanowanie 9229–9249 albo `INSPECTOR_PORTS`, nazwy z `package.json` lub `APP_NAMES`, jeden kolektor dla wszystkich aplikacji, filtr `app` **[README]**.

---

## 4. Wymagania i ograniczenia

| | Next.js MCP | node-outbound-inspector |
|---|---|---|
| Wersja frameworka | Next ≥ 16 dla endpointu; `get_routes` od 16.1; kompilacja i `get_request_insights` od 16.3 **[K]** | Next 16.1+ (`next dev --inspect`), sprawdzone na 16.4 |
| Node | `next-devtools-mcp`: Node ≥ 20.19 **[D]**; aplikacja jak wymaga Next | ≥ 24 dla kolektora i aplikacji |
| Bundler | `get_compilation_issues` i `compile_route` **tylko Turbopack** **[D]**; reszta niezależna | niezależny (mapy źródeł Turbopack w planie M5) |
| Konfiguracja | zero dla podstaw; `experimental.requestInsights: true` dla `fetch` **[D]** | flaga Node w linii poleceń i unikalny `--inspect` na aplikację (`outbound-next`) |
| Tryb | tylko `next dev` **[D, K]** | tylko lokalny dev |
| Edge runtime | brak informacji w źródłach (nie sprawdzono) | nieobsługiwany |
| Bun | `bun dev` w dokumentacji jako sposób uruchomienia **[D]**; runtime Bun (`--bun`) nie sprawdzony | Bun jako menedżer i `bun run`: tak; runtime Bun: nie |
| Widoczne strony | `get_errors` i `get_page_metadata` wymagają otwartej strony w przeglądarce **[D]** | ruch widać niezależnie od przeglądarki (np. `curl`) |
| Telemetria | `next-devtools-mcp` wysyła anonimową telemetrię, wyłącza ją `NEXT_TELEMETRY_DISABLED=1` **[D]**; Next liczy wywołania narzędzi MCP **[K]** | brak |
| Bezpieczeństwo danych | URL-e oczyszczone z sekretów, atrybuty z białej listy, brak treści **[K]** | redakcja nagłówków, URL i pól JSON; treści do modelu (tryby `eager`, `lazy`, `off`) |

---

## 5. Tabela porównawcza

Ocena: **pokrywa się** = oba dają to samo; **uzupełnia** = jedno widzi to, czego nie ma drugie, i warto używać obu; **brakuje u nas** / **brakuje w Next**.

| Funkcja | Next.js MCP | node-outbound-inspector | Ocena |
|---|---|---|---|
| Lista `fetch` serwera z URL, metodą, statusem, czasem | `get_request_insights` (wymaga flagi) | `list_server_requests` | **pokrywa się** |
| Przypisanie `fetch` do żądania strony | `requestId`, `htmlRequestId`, `route` (wzorzec) | `page`, `page_request_id` (URL żądania) | **pokrywa się**; Next ma wzorzec trasy i powiązanie RSC z dokumentem, my nie |
| `node:http` (axios, got, SDK, SOAP) | brak | tak | **brakuje w Next** |
| `fetch` poza kontekstem żądania (start, zadania w tle, `fetch` bez `workStore`) | brak (bez `requestId` nie jest zapisywany) | tak (grupa „no page”) | **brakuje w Next** |
| Nagłówki żądania i odpowiedzi | brak | tak, z redakcją | **brakuje w Next** |
| Treść odpowiedzi (i żądania, gdy dostępna) | brak | tak, stronicowana | **brakuje w Next** |
| Czas do końca treści, TTFB | tylko do nagłówków | oba | **brakuje w Next** |
| Błędy sieci (zerwane połączenie, odmowa) | niepewne (najwyżej span `error`) | `failed` z `error_kind` | **brakuje w Next** (częściowo) |
| Wykrywanie waterfall, oszczędność `Promise.all`, zależności danych | brak | `analyze_server_timeline` | **brakuje w Next** |
| Duplikaty, wolne zapytania, w toku | brak | `findings` | **brakuje w Next** |
| Status cache `fetch` (`hit`, `miss`, `skip`, `hmr`) i powód | tak | brak (trafienie w cache = brak zapytania) | **brakuje u nas** → uzupełnia |
| Spany renderowania (render, segmenty, proxy) | tak | brak | **brakuje u nas** → uzupełnia (poza zakresem) |
| Błędy kompilacji i runtime | `get_errors`, `get_compilation_issues`, `compile_route` | brak | **brakuje u nas** → uzupełnia (poza zakresem) |
| Trasy, metadane strony, projekt | `get_routes`, `get_page_metadata`, `get_project_metadata` | brak | **brakuje u nas** → uzupełnia (poza zakresem) |
| Server Action → plik | `get_server_action_by_id` | brak (w planie M7 tylko ID akcji) | **uzupełnia** |
| Logi serwera i przeglądarki | `get_logs` (ścieżka pliku) | brak | **uzupełnia** |
| Dokumentacja, upgrade, Cache Components | `nextjs_docs`, skille | brak | poza zakresem |
| Miejsce w kodzie (plik:linia) wywołania `fetch` | brak | `origin` (w Next ograniczone; M5) | **brakuje w Next** |
| Wiele aplikacji naraz | tak, per port; bez nazw; porty 3000–3010 albo wykrywanie procesu | tak, nazwy z `package.json`, jeden kolektor | **pokrywa się**; u nas wygodniej w monorepo |
| Filtry i stronicowanie | `requestId`, `htmlRequestId`; canary: podsumowanie 20 | `app`, `page_contains`, `url_contains`, `status`, `last_ms`, `since_id`, … | **brakuje w Next** |
| Limit rozmiaru wyniku | 16.4.6: brak; canary: podsumowanie i 1 MB | twardy limit 20 000 znaków z `truncation_hint` | **brakuje w Next** (16.4) |
| Nie-Next (dowolny proces Node) | nie | tak | **brakuje w Next** |
| Zero zmian w uruchamianiu aplikacji | tak (flaga w `next.config`) | nie (flaga Node, port inspektora) | **brakuje u nas** |
| Edge runtime | nieznane | nie | — |

---

## 6. Wnioski i rekomendacje

### 6.1. Czy dublujemy Next MCP? [W]

Nie. Część wspólna to szkielet: lista `fetch` z czasem i stroną. Wartość naszego narzędzia leży poza nią: nagłówki, treści, `node:http`, ruch spoza żądania, błędy sieci, analiza osi czasu i limit wyniku. Next ma z kolei to, czego my z założenia nie zobaczymy: cache (`hit`, `hmr`), wzorzec trasy, spany renderu, błędy i kompilację. Ryzyko 9 z `architecture.md` („Next sam dostarczy to samo”) jest dziś **niskie dla danych sieciowych**. Kod canary rozwija Request Insights w stronę ergonomii (podsumowania, historia), nie nagłówków i treści. Warto to sprawdzać przy każdej wersji minor.

**Kiedy samo Next MCP wystarczy:** zespół używa wyłącznie `fetch` w App Routerze, a pytanie brzmi „ile zapytań i czy trafiają w cache”. Wtedy `get_request_insights` nie wymaga zmian w uruchamianiu i daje dane bez inspektora.

### 6.2. Jak używać obu razem (przepływ dla agenta) [W]

Jeden agent, dwa serwery MCP (`.mcp.json`: `next-devtools` i `outbound`), do tego przeglądarka (`agent-browser` przez skill `next-dev-loop` albo Chrome DevTools MCP). W `next.config` każdej aplikacji (tylko dev) `experimental.requestInsights: true`.

1. `outbound.inspector_status` → aplikacje i porty. `next-devtools.nextjs_index` (z `port`, jeśli wykrywanie zawiedzie).
2. `outbound.clear_server_requests` → otwarcie strony w przeglądarce.
3. `outbound.analyze_server_timeline({ settle_ms: 500 })` → waterfall, błędy, wolne zapytania, `page_request_id`.
4. `next-devtools.nextjs_call(port, "get_request_insights", { requestId | htmlRequestId })` → wzorzec trasy, status cache każdego `fetch`, spany renderu. Wyjaśnia, dlaczego czegoś **nie** ma w naszym ruchu (`hit` lub `hmr`).
5. `outbound.get_server_request(id)` dla błędów (treść odpowiedzi serwisu); `nextjs_call(port, "get_errors")` dla błędów renderu; `get_server_action_by_id` dla akcji.
6. Po poprawce kodu: `compile_route`, potem powtórka kroków 2–3 i porównanie `wall_ms`.

### 6.3. Co dodać lub zmienić

| # | Zmiana | Uzasadnienie | Koszt |
|---|---|---|---|
| 1 | **Hak czyta przy żądaniu strony `x-nextjs-request-id`, `x-nextjs-html-request-id` i `traceparent`.** Pola `next_request_id` i `next_html_request_id` w wynikach, filtry o tych samych nazwach. | Dokładne złączenie z `get_request_insights` dla nawigacji RSC i Server Actions **[K]**. Grupowanie wszystkich żądań jednego wyświetlenia strony (dokument + RSC + akcje) także bez Next MCP. Tylko odczyt. | S (zakres M7, można wcześniej) |
| 2 | Opcjonalnie (opt-in): dla dokumentu HTML bez nagłówka hak ustawia `x-nextjs-request-id` na nasz `page_request_id` przed obsługą przez Next. | Next bierze ID z nagłówka **[K]**, więc złączenie byłoby dokładne także dla pierwszego wejścia. Wymaga sprawdzenia, że `http.server.request.start` poprzedza odczyt nagłówka w procesie serwera Next **[H]**. Zmienia żądanie, więc tylko za zgodą. | S |
| 3 | `inspector_status`: port HTTP aplikacji (np. `req.socket.localPort` z haka) i URL serwera dev. | Agent poda port do `nextjs_call` bez zgadywania, co omija problem wykrywania z punktu 3. | S |
| 4 | `llms.txt` i README: sekcja „razem z Next DevTools MCP” (przepływ z 6.2, `requestInsights`, porty 3000–3010 lub jawne porty, interpretacja braku zapytania jako możliwego trafienia w cache). | Agent nie zgaduje podziału ról. | S |
| 5 | `architecture.md`: zamknąć S5 i pytanie otwarte 5 wynikiem tej analizy; zaktualizować sekcję 6.4 („`get_request_insights` widzi tylko `fetch` w kontekście żądania, bez nagłówków i treści”) i ryzyko 9. | Dokument opiera się dziś na założeniu sprzed sprawdzenia. | S |
| 6 | Sprawdzić **[H]**, czy żądania `POST /_next/mcp` (od `next-devtools-mcp`) i `/_next/webpack-hmr` pojawiają się jako żądania stron w `analyze_server_timeline`; jeśli tak, pomijać je domyślnie. | Szum w podsumowaniu. | S |

**Z czego zrezygnować lub czego nie budować** **[W]**:

- Nie dodawać niczego o routingu, błędach, kompilacji ani cache Next. To robi Next MCP, a my nie mamy dostępu do tych danych bez zależności od wnętrza frameworka.
- Plan M7 „identyfikator akcji” zostawić jako pole. Mapowanie ID → plik robi `get_server_action_by_id`.
- Nie budować własnego panelu cache ani spanów renderu. Jeśli zespół chce jednego widoku, lepszą drogą jest agent łączący oba źródła.
- Rozważyć, czy M5 (miejsce wywołania przez Proxy na `fetch`) jest nadal wart ryzyka. Next podaje `index` i `route`, a agent z URL i trasą zwykle znajdzie kod. M5 zostaje cenny dla `node:http` i dla kodu poza `page.tsx` (helpery, pakiety workspace); to decyzja do podjęcia po S3.

### 6.4. Czy możemy się zintegrować z Next MCP? [W]

| Sposób | Wykonalność | Uwagi |
|---|---|---|
| Korelacja po `x-nextjs-request-id` / `x-nextjs-html-request-id` | **wysoka** | Nagłówki wysyła przeglądarka w dev **[K]**; patrz 6.3 punkt 1. |
| Korelacja przez `self.__next_r` | wysoka (przez agenta) | Agent czyta `self.__next_r` w przeglądarce (`evaluate_script`, `agent-browser`) i filtruje oba narzędzia po `htmlRequestId`. |
| Korelacja po URL i czasie | średnia | `startTime` w Next to `performance.timeOrigin + performance.now()` (ms epoki) **[K]**, u nas `wallTime`. Zgodne co do zegara, ale `durationMs` Next kończy się na nagłówkach. Dobra ścieżka awaryjna. |
| Korelacja po `traceId` | niska | Bez OTel `traceId` Next jest lokalnym licznikiem **[K]**. Czy trafia do zapytań wychodzących jako `traceparent` (bez OTel i z OTel), nie sprawdzono **[H]**; bez tego nie ma po czym łączyć. Wartość tylko w zespołach, które już mają `@vercel/otel`. |
| Nasz kolektor woła `/_next/mcp` (np. `get_request_insights`) i wzbogaca wyniki o `route` i `cacheStatus` | możliwa, ale **niezalecana teraz** | Zależność od eksperymentalnego, zmieniającego się kształtu (16.4 i canary się różnią) i od flagi. Agent łączy dane taniej. Wrócić do tego, gdy Request Insights przestanie być eksperymentalne. |
| Odwrotnie: Next pokazuje nasze dane | nie | Brak punktu rozszerzeń dla narzędzi `/_next/mcp` **[K: `get-or-create-mcp-server.ts` rejestruje stałą listę]**. |

---

## Źródła

**Dokumentacja i blog Next.js**
- Next.js MCP Server (lastUpdated 2026-10-02): <https://nextjs.org/docs/app/guides/mcp>
- AI Coding Agents (w repozytorium, v16.4.6): `docs/01-app/02-guides/ai-agents.mdx`
- `logging` (v16.4.6): `docs/01-app/03-api-reference/05-config/01-next-config-js/logging.mdx`; online: <https://nextjs.org/docs/app/api-reference/config/next-config-js/logging>
- Next.js 16.3 (2026-08-03): <https://nextjs.org/blog/next-16-3>
- Next.js 16.3: AI Improvements (2026-06-26; mniejszy serwer MCP, `get_compilation_issues`, `compile_route`, `next-dev-loop`): <https://nextjs.org/blog/next-16-3-ai-improvements>

**Kod `vercel/next.js`** (tag `v16.4.6`, porównanie z `canary` @ v16.5.0-canary.57): <https://github.com/vercel/next.js>
- `packages/next/src/server/mcp/get-or-create-mcp-server.ts`, `get-mcp-middleware.ts`, `tools/*.ts`
- `packages/next/src/server/lib/trace/request-insights.ts`, `span-store.ts`, `local-span-recorder.ts`, `tracer.ts`, `request-insights-identity.ts`
- `packages/next/src/server/lib/patch-fetch.ts` (`trackFetchMetric`, span `AppRender.fetch`)
- `packages/next/src/server/base-server.ts` (nagłówki `x-nextjs-request-id`, `x-nextjs-html-request-id`)
- `packages/next/src/client/components/app-router-headers.ts`, `router-reducer/fetch-server-response.ts`, `router-reducer/reducers/server-action-reducer.ts`, `server/app-render/app-render.tsx` (`self.__next_r`)
- `packages/next/src/server/dev/log-requests.ts`, `dev/browser-logs/file-logger.ts`, `dev/browser-logs/receive-logs.ts`, `dev/next-dev-server.ts`
- `packages/next/src/server/config-shared.ts` (`requestInsights`, `mcpServer`)
- canary: `packages/next/src/shared/lib/request-insights-summary.ts`, zmiany w `get-request-insights.ts`
- Lista narzędzi w tagach v16.0.0, v16.1.0, v16.2.0, v16.3.0, v16.4.0 (`git ls-tree`)

**Kod `vercel/next-devtools-mcp`** 0.4.1 (commit `1e8dcfa`, 2026-09-14): <https://github.com/vercel/next-devtools-mcp>
- `README.md`, `CHANGELOG.md`, `src/_internal/nextjs-runtime-manager.ts`, `src/tools/nextjs_index.ts`, `src/tools/nextjs_call.ts`

**Nasze repozytorium:** `README.md`, `llms.txt`, `src/mcp/tools.mjs`, `src/outbound-mcp.mjs`, `src/hook/hook.mjs`, `docs/architecture.md`.
