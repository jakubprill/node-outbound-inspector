# Changelog

Format oparty na [Keep a Changelog](https://keepachangelog.com/pl/1.1.0/), wersjonowanie zgodne z [SemVer](https://semver.org/lang/pl/).

## [Unreleased]

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
