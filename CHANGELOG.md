# Changelog

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), wersjonowanie zgodne z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

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
