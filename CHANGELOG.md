# Changelog

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), wersjonowanie zgodne z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

### Dodane
- **Współpraca z Next DevTools MCP:** żądania stron mają `next_request_id` i `next_html_request_id` z nagłówków `x-nextjs-request-id` / `x-nextjs-html-request-id` (złączenie z `get_request_insights`; także filtry), `inspector_status` podaje `http_ports` aplikacji (do `nextjs_index` / `nextjs_call`), żądania wewnętrznych endpointów dev Next (`/_next/mcp`, HMR, `/__nextjs_*`) nie są żądaniami stron. Sekcja „Together with Next DevTools MCP” w README i `llms.txt`.
- **`outbound-hub`:** wszystkie aplikacje w `chrome://inspect` bez wpisywania portów. Słucha na `127.0.0.1:9229` (adres sprawdzany przez Chrome domyślnie), znajduje procesy z inspektorem na skanowanych portach, nazywa je jak kolektor i przepina połączenie DevTools do właściwego procesu (TCP po nagłówkach Upgrade, bez zależności). Odpowiada tylko na `Host` będący adresem IP lub `localhost` i łączy tylko ze znalezionymi procesami. Sprawdzone na Chrome 153: lista celów i „inspect”. Kolektor MCP pomija cele huba (pole `outboundHub`), więc nie dubluje aplikacji.

### Naprawione
- Testy na Windows (issue #7): normalizacja golden zamienia `\` na `/` przed podmianą katalogu głównego; test haka kończy proces zamknięciem serwerów zamiast `process.exit()` (na Windows exit przy otwartych połączeniach keep-alive wywraca libuv); `npm test` i `npm run golden:update` działają w `cmd.exe`.
- CI uruchamia testy także na Windows i macOS (Node 24).

## [0.5.0] — 2026-11-19

### Zmienione (niezgodne z 0.4.0)
- **`list_server_requests` zwraca obiekt** `{ requests, next_since_id }` zamiast tablicy, z `has_more`/`remaining` przy stronicowaniu i `older_not_shown`, gdy nie pokazano starszych. Obiekt jest potrzebny, żeby wynik mógł nieść kursor i znacznik przycięcia.
- **`analyze_server_timeline` domyślnie zwraca podsumowanie** (M6, ADR 0008): 20 najnowszych żądań stron bez `timeline`, do 10 błędów (`errors_total`, gdy jest ich więcej), do 10 serii bez strony, pole `detail: "summary"`. Pełny raport po podaniu `page_request_id` albo `detail: "full"`. Pola używane dotąd (`by_page_request`, `verdict`, `verdict_code`, `sequential_chains`, `errors`, `in_flight`) zostają.
- Wyniki narzędzi to JSON bez wcięć. W listach i analizie query string dłuższy niż 80 znaków jest skracany do `?…`; pełny URL zwraca `get_server_request`.
- Reguła nazw sekretów nie obejmuje już `author…` (`auth(?!or)`).

### Dodane
- **Twardy budżet odpowiedzi** (wada 5, M6): każdy wynik mieści się w `OUTBOUND_MAX_RESPONSE_CHARS` (domyślnie 20 000 znaków). Wynik przycięty ma `truncated: true` i `truncation_hint`. Przycinane są najpierw najstarsze elementy największych tablic. Test własności na losowych magazynach do 5000 zapytań; 132 zapytania dają podsumowanie poniżej 6000 znaków.
- `list_server_requests`: kursor (`since_id` → `next_since_id`, każdy rekord dokładnie raz), filtry `page_request_id` i `status` (`404`, `5xx`, `error`, `failed`, `pending`; także w `analyze_server_timeline`).
- `get_server_request`: stronicowanie treści (`body_offset`, `body_next_offset`), pełny URL.
- `analyze_server_timeline`: `settle_ms` (czeka, aż nic nie jest w toku i ruch ucichł, najwyżej 15 s; wynik ma `settle`), ustalenia `findings.duplicates` (ta sama metoda i URL w obrębie żądania strony albo serii) i `findings.slow` (`slow_ms`, domyślnie 1000).
- **Redakcja sekretów w treściach JSON:** wartości skalarne pól o nazwach jak sekrety (`access_token`, `client_secret`, `password`, …) są zastępowane opisem przy przyjęciu, także w treści przyciętej; `body_redacted_fields` w `get_server_request`.
- **Era MCP 2026-07-28** obok `initialize`: `server/discover`, wersja i możliwości klienta w `_meta` każdego żądania, `resultType: "complete"` i `serverInfo` w `_meta` wyników, błąd `-32022` dla nieobsługiwanej wersji, `-32602` przy braku wymaganych pól.

## [0.4.0] — 2026-11-19

### Dodane
- `llms.txt` (po angielsku): instrukcja dla agentów AI (integracja z projektem, także z własnym skryptem spawnującym aplikacje, weryfikacja, narzędzia, pułapki).
- README po angielsku (`README.md`) i po polsku (`README.pl.md`) z przełącznikiem języka.

### Zmienione (kontrakt narzędzi)
- **Narzędzia MCP mówią po angielsku:** opisy narzędzi i parametrów, `instructions` serwera, werdykty (`SEQUENTIAL`/`PARALLEL`/`MIXED`/`single request`), wskazówki, powody stanu treści, ostrzeżenia, błędy oraz opis redakcji (`[redacted: Bearer · 19 chars · #a1b2c3]`). Komunikaty `outbound-next`, logi kolektora i skrypt demo też są po angielsku. Pola i kody (`verdict_code`, `body_state`, `error_kind`) bez zmian, więc logika oparta na kodach działa dalej.

### Zmienione
- **Minimalna wersja Node to 24** (`engines`, CI na 24 i najnowszej). Wsparcie dla Node 22 zostało usunięte:
  - kolektor (`outbound-mcp`) i `outbound-next` odmawiają startu na Node < 24;
  - proces aplikacji na Node < 24 nie jest podsłuchiwany, a powód jest w `inspector_status`;
  - kod i nagranie zdarzeń dla Node 22 zostały usunięte;
  - doszło nagranie zdarzeń z Node 24.

### Naprawione
- **Podłączenie kolektora wywracało połączenia aplikacji** czytającej odpowiedzi `node:http` po `res.setEncoding()`. To błąd Node [#66551](https://github.com/nodejs/node/issues/66551), zweryfikowany na Node 24.22.3: `TypeError: Missing dataLength in event`, a aplikacja nie dostaje odpowiedzi. Kolektor instaluje w procesie aplikacji obejście przed `Network.enable` (`src/hook/node-fixes.mjs`), a `inspector_status` pokazuje je w nowym polu `node_workarounds`.

### Naprawione (zgłoszenia #1–#6)
- **#1** Treści z `content-encoding` (gzip, x-gzip, br, deflate zlib/raw, zstd) są dekompresowane. Wieloetapowe kodowanie i wielkość liter są obsługiwane, a limit wyniku chroni przed bombą dekompresyjną (stan `truncated`). Obcięcie jest wykrywane po bajtach skompresowanych. Dochodzą pola `body_encoding` i `body_encoded_bytes`. Uszkodzone lub nieznane kodowanie daje stan `skipped` z powodem. Odpowiedź z `charset` w `content-type`, którą inspektor Node zamienia na zniekształcony tekst, ma stan `unavailable`.
- **#2** Miejsce wywołania (`origin`) pomija ramki dowolnych bibliotek: każdy `node_modules/`, pnpm, Yarn PnP i chunki Turbopacka z bibliotekami (`node_modules_…`, `…__pnpm_…`, `[turbopack]_runtime`, `[externals]_…`, `__next-internal_`). Pomija też `vendor-chunks/` i runtime webpacka, a ścieżki Windows są normalizowane. Chunki `[root-of-the-server]__…` zostają, bo zawierają kod aplikacji (sprawdzone na Next 16.4). Doszła nowa zmienna `OUTBOUND_LIBRARY_PATHS`.
- **#3** Nieudane zapytanie bez opisu błędu ma status `FAILED (brak opisu błędu od inspektora)` zamiast `FAILED: `. Przyczyną jest `AggregateError`, gdy `localhost` rozwiązuje się do IPv4 i IPv6. `get_server_request` podaje dodatkowo `error_kind` (np. `connection_refused`, `timeout`) i `error_hint`.
- **#4** Eksport OpenTelemetry (`/v1/traces|metrics|logs` na porcie 4318, OTLP/gRPC `…Service/Export`) jest domyślnie pomijany. Wyłącza to `OUTBOUND_IGNORE_OTLP=0`. `inspector_status` pokazuje reguły (`ignored_otlp`) i liczniki pominiętych zapytań (`ignored_requests_total`).
- **#5** Nowe polecenie `outbound-next` uruchamia `next` z inspekcją sieci bez pośrednictwa powłoki. Działa w `cmd.exe` i PowerShell, z npm, pnpm, Yarn i Bun. README i przykład monorepo zostały zaktualizowane, a README opisuje też wariant ze ścieżką względną.
- **#6** Analiza wykrywa zależności danych między zapytaniami: wartość z odpowiedzi A występuje w URL-u albo nagłówkach B. Kroki zależne nie liczą się do oszczędności, a `hint` nie proponuje `Promise.all`. Dochodzą pola `dependencies` i `dependency_check` (`complete`, `partial` albo `unavailable`, gdy brak treści).

### Znane ograniczenia (znalezione przy zgłoszeniach)
- `node:http`: gdy połączenie zerwie się w trakcie odbierania treści, inspektor Node nie wysyła ani `loadingFinished`, ani `loadingFailed`, więc zapytanie zostaje w toku.

### Naprawione (M2 — poprawność i bezpieczeństwo rdzenia)
- **Wada 2:** proces bez `--experimental-network-inspection` nie jest już raportowany jako działający. `inspector_status` sprawdza flagę w `process.execArgv` (bo `Network.enable` odpowiada sukcesem także bez niej) i podaje powód w `warnings`.
- **Wada 3:** klucz rekordu to numer podłączenia (`processId`) i `requestId`, a nie port, więc po restarcie aplikacji na tym samym porcie rekordy sprzed restartu zostają.
- **Wada 4:** treść odpowiedzi ma jawny stan (`body_state`: `available`, `truncated`, `unavailable`, `evicted`, `skipped`, `none`) i powód (`body_reason`) zamiast pustego łańcucha. Na Node < 24 treść `fetch` ma stan `unavailable`, a status pokazuje ostrzeżenie. Treści binarne nie są dekodowane jako UTF-8.
- **Wada 6:** redakcja sekretów przy przyjęciu danych. Nagłówki uwierzytelniające (`authorization`, `cookie`, `set-cookie`, `x-api-key`, …) i nagłówki oraz parametry URL o nazwach pasujących do wzorca (`token`, `secret`, `password`, `session`, `key`, `auth`, …) są zastępowane opisem `[zredagowano: Bearer · 19 zn. · #a1b2c3]`. Skrót to HMAC z kluczem losowanym przy starcie kolektora.

### Dodane (M2)
- Tryby treści `OUTBOUND_BODIES=eager|lazy|off`, limit treści na odpowiedź (`OUTBOUND_BODY_MAX_KB`, 256) i budżet wszystkich treści w kolektorze (`OUTBOUND_BODIES_TOTAL_MB`, 32; najpierw usuwane najstarsze treści odpowiedzi bez błędu).
- Własne limity bufora treści w procesie aplikacji przy `Network.enable` (`OUTBOUND_INSPECTOR_BUFFER_MB` 32, `OUTBOUND_INSPECTOR_RESOURCE_MB` 2), zamiast domyślnych ok. 100 MB na sesję.
- `OUTBOUND_REDACT=0` (wyłącza redakcję, z ostrzeżeniem w statusie) i `OUTBOUND_REDACT_HEADERS` (dodatkowe nagłówki firmowe).
- Pola addytywne w wynikach: `inspector_status` → `apps[].node`, `apps[].ready`, `apps[].warnings`, `redaction`, `bodies`, `warnings`; `get_server_request` → `body_state`, `body_bytes`, `body_reason`, `ttfb_ms`; `analyze_server_timeline` → `in_flight` (+ `in_flight_requests`), `verdict_code` (`single`, `sequential`, `parallel`, `mixed`).
- MCP: lista wspieranych wersji protokołu zamiast odsyłania dowolnej, pole `instructions` z zalecanym przebiegiem pracy i ostrzeżeniem, że treści to dane, a wersja serwera pochodzi z `package.json`.
- Normalizacja `wallTime` (sekundy albo milisekundy).
- Nagrania zdarzeń z treściami odpowiedzi, z Node 22 i Node 26.

### Zmienione (M2)
- `get_server_request`: gdy treść nie jest dostępna, `body` ma wartość `null` (wcześniej pusty łańcuch). Powód jest w `body_state` i `body_reason`.

### Zmienione (M1 — refaktor bez zmiany zachowania)
- `src/outbound-mcp.mjs` podzielony na moduły zgodnie z `docs/architecture.md`: `config`, `discovery`, `cdp-client`, `session`, `ingest`, `store`, `correlate`, `frames`, `analyze/*`, `hook/hook`, `mcp/server`, `mcp/tools`, `mcp/render`, z korzeniem kompozycji `collector.mjs`. Narzędzia, wyniki, zmienne środowiskowe i ścieżka punktu wejścia bez zmian.

### Dodane
- Testy charakteryzacyjne (golden) kontraktu narzędzi MCP: `test/golden/`, odświeżanie przez `npm run golden:update`.
- Testy jednostkowe czystych modułów (`test/unit/`), w tym odtwarzanie nagrań zdarzeń CDP.
- `scripts/record-fixture.mjs` (`npm run record`): nagrywanie surowego ruchu inspektora do NDJSON. Pierwsze nagranie: Node 22.
- Znane wady prototypu jako testy `todo` (`test/e2e/known-defects.test.mjs`) — do naprawy w M2.
- CI: macierz Node 22, 24 i bieżącej wersji.

## [0.3.0] — 2026-11-19
Pierwsza wersja w repozytorium (prototyp).

### Dodane
- `src/outbound-mcp.mjs`: serwer MCP (stdio, bez zależności) podłączający się do inspektorów Node uruchomionych z `--experimental-network-inspection`.
- Obsługa wielu aplikacji naraz: skanowanie zakresu portów i rozpoznawanie aplikacji po `npm_package_name`, `package.json` w `cwd` albo `APP_NAMES`.
- Przypisanie zapytań wychodzących do żądania strony (`diagnostics_channel` i `AsyncLocalStorage`, bez zmian w aplikacji).
- Analiza osi czasu: zapytania sekwencyjne (waterfall), równoległe i mieszane, możliwa oszczędność z `Promise.all`, błędy 4xx/5xx i zerwane połączenia.
- Narzędzia: `inspector_status`, `list_server_requests`, `get_server_request`, `analyze_server_timeline`, `clear_server_requests`.
- Testy e2e (dwie aplikacje uruchomione równolegle), przykład monorepo Next.js, skrypt demonstracyjny, dokumentacja analizy i wyników testów.

[Unreleased]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jakubprill/node-outbound-inspector/releases/tag/v0.4.0
