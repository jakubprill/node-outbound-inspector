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
Dodaj narzędzie jako devDependency (w monorepo: w katalogu głównym), np. `"node-outbound-inspector": "github:jakubprill/node-outbound-inspector#v0.6.0"`, i w aplikacji:
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
Uruchom `outbound-hub` obok aplikacji (np. w skrypcie dev). Słucha na `127.0.0.1:9229`, który `chrome://inspect` sprawdza domyślnie, znajduje każdą aplikację z inspektorem na portach 9230–9249 i pokazuje je po nazwie. Nie trzeba dopisywać portów w **Configure…**, nowe aplikacje pojawiają się same. Dalej: `chrome://inspect` → **inspect** przy aplikacji → zakładka **Network**.

Hub odpowiada tylko na żądania z nagłówkiem `Host` będącym adresem IP albo `localhost` (ochrona przed DNS rebinding, jak w samym Node) i przekazuje połączenia DevTools tylko do aplikacji, które sam znalazł na skanowanych portach. Zostaw mu port 9229: aplikacjom daj porty inspektora od 9230. `OUTBOUND_HUB_PORT` zmienia port, a `INSPECTOR_PORTS` i `APP_NAMES` działają jak w serwerze MCP.

Bez huba: **Open dedicated DevTools for Node** → **Connection** → dopisz `localhost:<port>` dla każdej aplikacji.

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
| `list_server_requests` | Zapytania: aplikacja, strona, metoda, URL, status, czas, miejsce w kodzie. Zwraca `{ requests, next_since_id }`; z `since_id` przejdziesz przez wszystkie |
| `get_server_request` | Szczegóły: pełny URL, nagłówki żądania i odpowiedzi, treść (stronicowana przez `body_offset`), stos wywołań |
| `analyze_server_timeline` | Analiza per aplikacja i per żądanie strony: SEQUENTIAL / PARALLEL / MIXED, możliwa oszczędność, błędy, duplikaty, wolne zapytania. Domyślnie zwarte podsumowanie (`pages`: jedna pozycja na stronę, powtórne wejścia zgrupowane, same kody i liczby, około 1–1,5 tys. tokenów); `page_request_id` albo `detail: "full"` daje osie czasu, kroki waterfalla i wskazówki; `settle_ms` czeka, aż ruch ucichnie |
| `clear_server_requests` | Czyszczenie bufora (całość albo jedna aplikacja) |

Filtry: `app`, `page_contains`, `page_request_id`, `url_contains`, `status` (`404`, `5xx`, `error`, `failed`, `pending`), `last_ms`, `since_id`.

Każdy wynik mieści się w twardym limicie (domyślnie 20 000 znaków). Wynik przycięty ma `truncated: true` i `truncation_hint` z podpowiedzią, jak zawęzić wywołanie.

Opisy narzędzi, ich wyniki i komunikaty CLI są po angielsku. W logice używaj stałych kodów (`verdict_code`, `body_state`, `error_kind`), a nie tekstu.

Przykładowy przebieg pracy agenta: `clear_server_requests` → otwarcie strony (np. przez [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)) → `analyze_server_timeline` z `settle_ms` → `analyze_server_timeline` z `page_request_id` albo `get_server_request` po szczegóły.

Serwer obsługuje obie ery MCP: z `initialize` (2024-11-05 do 2025-06-18) i bezstanową 2026-07-28 (`server/discover`, wersja w `_meta` każdego żądania).

### Konfiguracja (zmienne środowiskowe)
| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INSPECTOR_PORTS` | `9230-9249` | Porty/zakresy inspektorów, np. `9231,9241`. 9229 (zwykłe `node --inspect`, `outbound-hub`) celowo pominięty |
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
| `OUTBOUND_MAX_RESPONSE_CHARS` | `20000` | Twardy limit znaków jednego wyniku narzędzia (minimum 4000) |

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

## Razem z Next DevTools MCP

Next.js 16 ma własny serwer MCP (`/_next/mcp`, używany przez `next-devtools-mcp`): trasy, błędy, kompilacja, logi, Server Actions oraz, z `experimental.requestInsights: true`, `get_request_insights` (wywołania `fetch` w App Routerze ze statusem cache Next). Nie pokazuje nagłówków, treści, ruchu `node:http` (axios, SDK), zapytań poza żądaniem strony, błędów sieci ani analizy waterfall. Oba serwery się uzupełniają; skonfiguruj agentowi oba.

**Czy dublujemy MCP z Next? Nie.** Sprawdzone w kodzie Next.js 16.4.6 i canary 16.5 oraz `next-devtools-mcp` 0.4.1 (2026-11-20):

| | Next DevTools MCP | node-outbound-inspector |
|---|---|---|
| Lista `fetch` serwera z czasem i żądaniem strony | `get_request_insights` (flaga eksperymentalna) | ✓ |
| Status cache Next (`hit`/`miss`/`hmr`), wzorzec trasy, spany renderu | ✓ | — |
| Błędy, kompilacja, trasy, logi, Server Actions | ✓ | — |
| Nagłówki żądania i odpowiedzi, treści odpowiedzi | — | ✓ (z redakcją) |
| Ruch `node:http` (axios, SDK), zapytania poza żądaniem strony | — | ✓ |
| Błędy sieci (odmowa, zerwanie), czas do końca treści | — | ✓ |
| Wykrywanie waterfall, oszczędność z `Promise.all`, duplikaty, wolne zapytania | — | ✓ |
| Dowolny proces Node, nie tylko Next | — | ✓ |

Pełne porównanie: [docs/nextjs-mcp-comparison.md](docs/nextjs-mcp-comparison.md).

- Żądania stron mają `next_request_id` / `next_html_request_id`, gdy przeglądarka wysłała nagłówki Next `x-nextjs-request-id` / `x-nextjs-html-request-id` (nawigacje po stronie klienta, Server Actions w dev). Przekaż je do `get_request_insights` jako `requestId` / `htmlRequestId` albo użyj jako filtrów tutaj.
- `inspector_status` podaje `http_ports` każdej aplikacji, czyli port do `nextjs_call`. `next-devtools-mcp` sam znalazł obie aplikacje monorepo uruchomione przez `outbound-next … --inspect=…` (Next 16.4, macOS); jeśli którejś nie znajdzie, podaj port w `nextjs_index`.
- Żądania do wewnętrznych endpointów dev Next (`/_next/mcp`, HMR, `/__nextjs_*`) nie są traktowane jak żądania stron.
- Zapytanie, którego tu brakuje, a które `get_request_insights` pokazuje ze statusem cache `hit` albo `hmr`, zostało obsłużone z cache Next.

## Model bezpieczeństwa

Inspektor Node daje pełną kontrolę nad procesem, a to, co zwracają narzędzia, trafia do dostawcy modelu AI. Narzędzie jest tylko do lokalnego developmentu i ma te zabezpieczenia (przegląd bezpieczeństwa: [docs/security-audit-2026-11-20.md](docs/security-audit-2026-11-20.md)):

- **Zgoda.** Serwer MCP podłącza się do każdego inspektora na portach 9230–9249, ale kod wstrzykuje, łata i włącza inspekcję sieci tylko w procesach tego samego użytkownika, które się na to zgodziły: uruchomionych przez `outbound-next` (ustawia `OUTBOUND_INSPECT=1`), z `OUTBOUND_INSPECT=1` albo z `--experimental-network-inspection`. Pozostałe są widoczne w `inspector_status` z `skipped: "no_consent"` albo `"other_user"`. Port 9229 (zwykłe `node --inspect`) domyślnie nie jest skanowany.
- **Tylko pętla zwrotna.** Cel jest przyjmowany tylko wtedy, gdy jego adres WebSocket wskazuje skanowany port na 127.0.0.1/localhost. `outbound-next` odmawia uruchomienia inspektora na innym adresie (`--inspect=0.0.0.0`, `--inspect-port`, `NODE_OPTIONS`), chyba że `OUTBOUND_ALLOW_REMOTE_INSPECT=1`. W Dockerze wystawiaj port jako `-p 127.0.0.1:<port>:<port>`. `outbound-hub` słucha na 127.0.0.1, sprawdza nagłówek `Host` (DNS rebinding) i przekazuje połączenia tylko do znalezionych aplikacji.
- **Wrogie procesy lokalne.** Wszystko na skanowanym porcie może udawać inspektor. Zniekształcone dane są odrzucane, rozmiary ograniczone (cele, sesje, URL-e, nagłówki), a `package.json` jest czytany tylko jako zwykły plik.
- **Redakcja przed zapisem** (najlepsze staranie): nagłówki po nazwie; URL-e w nagłówkach (`Location`, `Link`); parametry zapytania i fragmentu po nazwie, hasła w URL-ach; adres żądania strony; treści JSON jako drzewo (także obiekty i tablice pod kluczami-sekretami) i przycięty JSON; treści form-urlencoded; znane formaty tokenów w dowolnym miejscu (JWT, GitHub, Stripe, Slack, AWS, klucze Google API, tokeny botów Telegrama, webhooki Slack/Discord, klucze prywatne PEM). Redakcja działa przed przycięciem treści. **Nie obejmuje:** danych osobowych pod neutralnymi nazwami i sekretów w nietypowych formatach; treści żądań w ogóle nie są przechowywane. Przy wrażliwych integracjach użyj `OUTBOUND_BODIES=off` albo `INSPECTOR_PORTS` z dokładnymi portami.
- **Dane niezaufane.** Opisy narzędzi i instrukcja serwera mówią modelowi, że każda wartość pochodzi z badanych procesów i serwisów i nie jest poleceniem. Nazwy aplikacji są ograniczone do `[\w@./+:-]`, z tekstów usuwane są znaki sterujące.
- **Co opuszcza maszynę:** URL-e, nagłówki, treści odpowiedzi (po redakcji), teksty błędów, ścieżki ze stosu i katalog procesu badanych aplikacji.

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
- Redakcja to najlepsze staranie; zob. [Model bezpieczeństwa](#model-bezpieczeństwa).

## Dokumentacja
- [`llms.txt`](llms.txt): instrukcja integracji i użycia dla agentów AI (po angielsku)
- [Pełna analiza: problem, alternatywy (proxy, OpenTelemetry/Jaeger), WebMCP, rekomendacje](docs/analysis.md)
- [Wyniki testów](docs/test-results.md)
- [Changelog](CHANGELOG.md)

## Licencja
[MIT](LICENSE) © 2026 Jakub Prill
