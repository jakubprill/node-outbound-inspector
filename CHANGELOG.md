# Changelog

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), wersjonowanie zgodne z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

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
