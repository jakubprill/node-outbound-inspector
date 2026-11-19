# node-outbound-inspector

[English](README.md) | **Polski**

[![test](https://github.com/jakubprill/node-outbound-inspector/actions/workflows/test.yml/badge.svg)](https://github.com/jakubprill/node-outbound-inspector/actions/workflows/test.yml)

Inspekcja **wychodzącego ruchu HTTP** procesów Node.js, np. serwera Next.js wołającego wewnętrzne integracje: w Chrome DevTools oraz dla agentów AI przez serwer **MCP**.

- 🔍 Podgląd zapytań serwera (`fetch`/undici, `node:http`, HTTP/2): URL, nagłówki, status, treść, czas.
- 🧩 **Wiele aplikacji naraz** (monorepo): każda wykrywana i nazywana automatycznie.
- 🧭 **Przypisanie do żądania strony**: wiadomo, które wejście na `/checkout` wywołało które zapytania, nawet gdy kilka stron renderuje się równolegle.
- 🌊 **Wykrywanie zapytań sekwencyjnych (waterfall)** i wyliczanie zysku z `Promise.all`, a także wykrywanie błędów 4xx/5xx.
- 📦 Zero zależności, **Node ≥ 24** (kolektor i aplikacje).

> Narzędzie tylko do **lokalnego developmentu**: inspektor Node daje pełną kontrolę nad procesem.

## Jak to działa

```
 przeglądarka ──► Next.js (Node) ──► wewnętrzne serwisy
                      │  --inspect=<port> --experimental-network-inspection
                      ▼  (Chrome DevTools Protocol: zdarzenia Network.*)
        ┌─────────────┴─────────────┐
 Chrome DevTools              outbound-mcp  ──► agent AI (Claude Code, Cursor, …)
 („dedicated DevTools         (MCP, stdio)
  for Node” → Network)
```

Node ma eksperymentalną flagę `--experimental-network-inspection` (od 22.6 / 20.18; narzędzie wymaga Node ≥ 24), która wysyła zdarzenia sieciowe do podłączonego klienta DevTools. `outbound-mcp` podłącza się jako taki klient do każdego procesu, zbiera zdarzenia i udostępnia je agentowi jako narzędzia MCP.

## Szybki start

### 1. Uruchom aplikację z inspekcją sieci
Dodaj narzędzie jako devDependency (w monorepo: w katalogu głównym), np. `"node-outbound-inspector": "github:jakubprill/node-outbound-inspector#v0.4.0"`, i w aplikacji:
```jsonc
// package.json aplikacji — każda aplikacja w monorepo ma WŁASNY port inspektora
"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
```
`outbound-next` znajduje `next` tak jak `require` z katalogu aplikacji i uruchamia go przez `node --experimental-network-inspection`. Wszystkie argumenty idą do `next`, a kod wyjścia i sygnały wracają do menedżera pakietów. Nie zależy od powłoki, więc działa z npm, pnpm, Yarn i Bun na Windows (`cmd.exe`, PowerShell), macOS i Linuksie. Ostrzega, gdy brakuje `--inspect=<port>` albo gdy inspektor ma słuchać poza `127.0.0.1`.
Plik CLI można wskazać ręcznie zmienną `OUTBOUND_NEXT_BIN` (ścieżka względem katalogu aplikacji).

<details><summary>Bez instalowania narzędzia</summary>

Ścieżka do pliku `next` jako zwykły argument `node` działa w każdej powłoce (ukośniki `/` są w porządku także na Windows):
```jsonc
"dev:inspect": "node --experimental-network-inspection ./node_modules/next/dist/bin/next dev --port 3101 --inspect=9231"
// monorepo, w którym menedżer wyniósł next do katalogu głównego (npm/Bun/Yarn z node_modules):
"dev:inspect": "node --experimental-network-inspection ../../node_modules/next/dist/bin/next dev --port 3101 --inspect=9231"
```
Gdzie leży `next`, sprawdzisz raz: `node -p "require.resolve('next/dist/bin/next')"` w katalogu aplikacji. W pnpm `node_modules/next` w aplikacji to symlink, więc działa wariant `./node_modules/…`. Yarn PnP nie ma `node_modules`, więc ścieżki nie ma czego wskazać. Tam użyj `outbound-next` (Yarn ładuje PnP przez `NODE_OPTIONS`, a proces potomny je dziedziczy; na PnP jeszcze niesprawdzone) albo `nodeLinker: node-modules`.

Dotychczasowy zapis `node --experimental-network-inspection $(node -p "require.resolve('next/dist/bin/next')") dev …` wymaga powłoki POSIX (sh, bash, zsh, Git Bash). npm i pnpm na Windows uruchamiają skrypty w `cmd.exe`, gdzie `$(…)` nie działa.
</details>

> ⚠️ Flaga **nie działa** w `NODE_OPTIONS` (Node ją odrzuca). Gdy dwie aplikacje używają tego samego portu (domyślnie 9229), druga po cichu działa bez inspektora.

Jeśli aplikacje uruchamia własny skrypt (np. przez `bun run`), zmień tak samo argumenty spawnu, z unikalnym portem inspektora dla każdej aplikacji. Aplikacja musi działać w runtime Node, nie Buna (`bun --bun` nie działa). Instrukcja krok po kroku dla agentów: [`llms.txt`](llms.txt).

### 2a. Podgląd w Chrome
`chrome://inspect` → **Open dedicated DevTools for Node** → zakładka **Network**.

### 2b. Podłącz agenta (MCP)
```bash
claude mcp add outbound -- node /ścieżka/do/node-outbound-inspector/src/outbound-mcp.mjs
```
Albo w konfiguracji klienta MCP:
```json
{ "mcpServers": { "outbound": { "command": "node", "args": ["/ścieżka/do/node-outbound-inspector/src/outbound-mcp.mjs"] } } }
```

## Narzędzia MCP

| Narzędzie | Opis |
|---|---|
| `inspector_status` | Podłączone aplikacje: nazwa, port, pid, katalog, stan korelacji stron |
| `list_server_requests` | Zapytania: aplikacja, strona, metoda, URL, status, czas, miejsce w kodzie |
| `get_server_request` | Szczegóły: nagłówki żądania i odpowiedzi, treść, stos wywołań |
| `analyze_server_timeline` | Analiza per aplikacja i per żądanie strony: SEQUENTIAL / PARALLEL / MIXED, możliwa oszczędność, błędy |
| `clear_server_requests` | Czyszczenie bufora (całość albo jedna aplikacja) |

Filtry: `app`, `page_contains`, `url_contains`, `last_ms`, `since_id`.

Opisy narzędzi, ich wyniki i komunikaty CLI są po angielsku. W logice używaj stałych kodów (`verdict_code`, `body_state`, `error_kind`), a nie tekstu.

Przykładowy przebieg pracy agenta: `clear_server_requests` → otwarcie strony (np. przez [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)) → `analyze_server_timeline` → `get_server_request` dla błędów.

### Konfiguracja (zmienne środowiskowe)
| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INSPECTOR_PORTS` | `9229-9249` | Porty/zakresy inspektorów, np. `9231,9241` |
| `APP_NAMES` | — | Nazwy po porcie, np. `9231=web,9241=admin`. Domyślnie nazwa pochodzi z `npm_package_name`, potem z `name` w `package.json` w katalogu procesu, potem z nazwy katalogu. |
| `PAGE_CORRELATION` | `1` | `0` wyłącza wstrzykiwanie kodu korelującego zapytania ze stronami |
| `OUTBOUND_REDACT` | `1` | `0` wyłącza redakcję sekretów (ostrzeżenie w `inspector_status`) |
| `OUTBOUND_REDACT_HEADERS` | — | Dodatkowe nagłówki do redakcji, np. `x-acme-token,x-tenant-secret` |
| `OUTBOUND_BODIES` | `eager` | Treści odpowiedzi: `eager` (od razu), `lazy` (przy `get_server_request`), `off` (nigdy) |
| `OUTBOUND_BODY_MAX_KB` / `OUTBOUND_BODIES_TOTAL_MB` | `256` / `32` | Limit treści jednej odpowiedzi i wszystkich treści w kolektorze |
| `OUTBOUND_INSPECTOR_BUFFER_MB` / `OUTBOUND_INSPECTOR_RESOURCE_MB` | `32` / `2` | Limity bufora treści w procesie aplikacji (na sesję) |
| `OUTBOUND_LIBRARY_PATHS` | — | Dodatkowe fragmenty ścieżek pomijane przy ustalaniu miejsca wywołania (`origin`), np. własny wrapper `fetch` w workspace: `packages/http-client/,@acme_tracing_` |
| `IGNORE_HOSTS` | `registry.npmjs.org` | Hosty pomijane (Next sam sprawdza aktualizacje) |
| `OUTBOUND_IGNORE_OTLP` | `1` | Pomija eksport OpenTelemetry (np. `@vercel/otel` bez lokalnego kolektora): `/v1/traces`, `/v1/metrics`, `/v1/logs` na porcie `4318` (dowolny host) i OTLP/gRPC (`…Service/Export`). `0` pokazuje ten ruch. Pominięte reguły i liczniki: `inspector_status` (`ignored_otlp`, `ignored_requests_total`). Eksport do chmury na innym porcie dodaj do `IGNORE_HOSTS`. |
| `MAX_REQUESTS` | `5000` | Rozmiar bufora |

## Przykład i testy

```bash
npm test                         # jednostkowe, golden (kontrakt narzędzi), e2e — bez Next.js i bez sieci
npm run record                   # nagranie zdarzeń inspektora do test/fixtures/recordings/
npm run golden:update            # odświeżenie zrzutów golden (zmiana kontraktu → wpis w CHANGELOG)
```

Budowa kodu i plan rozwoju: [`docs/architecture.md`](docs/architecture.md), decyzje: [`docs/adr/`](docs/adr/).

Przykładowe monorepo z dwiema aplikacjami Next.js: [`examples/nextjs-monorepo`](examples/nextjs-monorepo/README.md)
```bash
cd examples/nextjs-monorepo && npm install
npm run mock          # udawane serwisy na :4001
npm run dev:inspect   # web :3101 (inspektor 9231) + admin :3102 (inspektor 9241)
npm run demo          # agent testowy: ruch + analiza
```
Skrypty `dev:inspect` aplikacji są przenośne (`outbound-next`). Skrypty zbiorcze w katalogu głównym przykładu (`&`/`wait`, `APPS=…`) wymagają powłoki POSIX; na Windows uruchom każdą aplikację w osobnym terminalu (`npm run dev:inspect -w @acme/web`), szczegóły w README przykładu.

Minimalny klient CDP (to, co robi zakładka Network): [`examples/cdp-network-probe.mjs`](examples/cdp-network-probe.mjs).

## Ograniczenia
- Funkcja Node jest **eksperymentalna**. Wymagany Node ≥ 24 (testowane w CI na 24 i najnowszej wersji). Na starszym Node kolektor nie startuje, a proces aplikacji nie jest podsłuchiwany (powód w `inspector_status`).
- **Bun** jako runtime nie jest obsługiwany (WebKit Inspector zamiast CDP). Działa, jeśli Bun służy tylko do instalowania pakietów i uruchamiania skryptów, a aplikacja działa na Node.
- W Next.js `fetch` jest opakowany przez sam Next, więc stos wywołań nie pokazuje linii strony. Kod znajduje się po URL-u i przypisanej stronie.
- Zapytania poza kontekstem żądania strony (start serwera, zadania w tle) trafiają do grupy „bez strony”.
- Edge runtime nie jest objęty.
- `outbound-mcp` wstrzykuje do procesu kod (`diagnostics_channel` i `AsyncLocalStorage`). Używaj wyłącznie lokalnie, z inspektorem na `127.0.0.1`.
- Treści z `content-encoding` (gzip, br, deflate, zstd) są dekompresowane (`body_encoding`, `body_encoded_bytes`). Gdy `content-type` ma `charset`, inspektor Node oddaje skompresowane bajty jako zniekształcony tekst i treść ma stan `unavailable`.
- **Błąd Node [#66551](https://github.com/nodejs/node/issues/66551):** gdy aplikacja czyta odpowiedź `node:http` po `res.setEncoding()` (robi tak wiele bibliotek), a do procesu jest podłączony klient z inspekcją sieci, Node rzuca `Missing dataLength in event` i niszczy połączenie. Aplikacja dostaje wtedy błąd albo nie dostaje odpowiedzi wcale. `outbound-mcp` instaluje w procesie aplikacji obejście przed włączeniem inspekcji (`node_workarounds` w `inspector_status`). **Same Chrome DevTools (bez kolektora) nadal wywołują ten błąd.**
- Zachowanie inspektora Node, na które narzędzie nie ma wpływu: gdy połączenie `node:http` zerwie się w trakcie odbierania treści, zapytanie zostaje w toku (brak zdarzenia końcowego).
- Sekrety w nagłówkach i parametrach URL są redagowane, zanim trafią do agenta. Treści odpowiedzi nie są redagowane (na razie), więc przy wrażliwych integracjach użyj `OUTBOUND_BODIES=off`.

## Dokumentacja
- [`llms.txt`](llms.txt): instrukcja integracji i użycia dla agentów AI (po angielsku)
- [Pełna analiza: problem, alternatywy (proxy, OpenTelemetry/Jaeger), WebMCP, rekomendacje](docs/analysis.md)
- [Wyniki testów](docs/test-results.md)
- [Changelog](CHANGELOG.md)

## Licencja
[MIT](LICENSE) © 2026 Jakub Prill
