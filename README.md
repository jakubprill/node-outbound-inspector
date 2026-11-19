# node-outbound-inspector

Inspekcja **wychodzącego ruchu HTTP** procesów Node.js, np. serwera Next.js wołającego wewnętrzne integracje: w Chrome DevTools oraz dla agentów AI przez serwer **MCP**.

- 🔍 Podgląd zapytań serwera (`fetch`/undici, `node:http`, HTTP/2): URL, nagłówki, status, treść, czas.
- 🧩 **Wiele aplikacji naraz** (monorepo): każda wykrywana i nazywana automatycznie.
- 🧭 **Przypisanie do żądania strony**: wiadomo, które wejście na `/checkout` wywołało które zapytania, nawet gdy kilka stron renderuje się równolegle.
- 🌊 **Wykrywanie zapytań sekwencyjnych (waterfall)** i wyliczanie zysku z `Promise.all`, a także wykrywanie błędów 4xx/5xx.
- 📦 Zero zależności: jeden plik `src/outbound-mcp.mjs`, Node ≥ 22 (zalecany ≥ 24).

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

Node od wersji 22.6 / 20.18 ma eksperymentalną flagę `--experimental-network-inspection`, która wysyła zdarzenia sieciowe do podłączonego klienta DevTools. `outbound-mcp` podłącza się jako taki klient do każdego procesu, zbiera zdarzenia i udostępnia je agentowi jako narzędzia MCP.

## Szybki start

### 1. Uruchom aplikację z inspekcją sieci
```jsonc
// package.json aplikacji — każda aplikacja w monorepo ma WŁASNY port inspektora
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --port 3101 --inspect=9231"
```
> ⚠️ Flaga **nie działa** w `NODE_OPTIONS` (Node ją odrzuca). Gdy dwie aplikacje używają tego samego portu (domyślnie 9229), druga po cichu działa bez inspektora.

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
| `analyze_server_timeline` | Analiza per aplikacja i per żądanie strony: SEKWENCYJNIE / RÓWNOLEGLE / MIESZANE, możliwa oszczędność, błędy |
| `clear_server_requests` | Czyszczenie bufora (całość albo jedna aplikacja) |

Filtry: `app`, `page_contains`, `url_contains`, `last_ms`, `since_id`.

Przykładowy przebieg pracy agenta: `clear_server_requests` → otwarcie strony (np. przez [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)) → `analyze_server_timeline` → `get_server_request` dla błędów.

### Konfiguracja (zmienne środowiskowe)
| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INSPECTOR_PORTS` | `9229-9249` | Porty/zakresy inspektorów, np. `9231,9241` |
| `APP_NAMES` | — | Nazwy po porcie, np. `9231=web,9241=admin`. Domyślnie nazwa pochodzi z `npm_package_name`, potem z `name` w `package.json` w katalogu procesu, potem z nazwy katalogu. |
| `PAGE_CORRELATION` | `1` | `0` wyłącza wstrzykiwanie kodu korelującego zapytania ze stronami |
| `IGNORE_HOSTS` | `registry.npmjs.org` | Hosty pomijane (Next sam sprawdza aktualizacje) |
| `MAX_REQUESTS` | `5000` | Rozmiar bufora |

## Przykład i testy

```bash
npm test                         # e2e: 2 aplikacje, przypisanie, waterfall, błędy (bez Next.js)
```

Przykładowe monorepo z dwiema aplikacjami Next.js: [`examples/nextjs-monorepo`](examples/nextjs-monorepo/README.md)
```bash
cd examples/nextjs-monorepo && npm install
npm run mock          # udawane serwisy na :4001
npm run dev:inspect   # web :3101 (inspektor 9231) + admin :3102 (inspektor 9241)
npm run demo          # agent testowy: ruch + analiza
```

Minimalny klient CDP (to, co robi zakładka Network): [`examples/cdp-network-probe.mjs`](examples/cdp-network-probe.mjs).

## Ograniczenia
- Funkcja Node jest **eksperymentalna**. Wymagany Node ≥ 24, bo na 22 brakuje treści odpowiedzi z `fetch`.
- **Bun** jako runtime nie jest obsługiwany (WebKit Inspector zamiast CDP). Działa, jeśli Bun służy tylko do instalowania pakietów i uruchamiania skryptów, a aplikacja działa na Node.
- W Next.js `fetch` jest opakowany przez sam Next, więc stos wywołań nie pokazuje linii strony. Kod znajduje się po URL-u i przypisanej stronie.
- Zapytania poza kontekstem żądania strony (start serwera, zadania w tle) trafiają do grupy „bez strony”.
- Edge runtime nie jest objęty.
- `outbound-mcp` wstrzykuje do procesu kod (`diagnostics_channel` i `AsyncLocalStorage`). Używaj wyłącznie lokalnie, z inspektorem na `127.0.0.1`.

## Dokumentacja
- [Pełna analiza: problem, alternatywy (proxy, OpenTelemetry/Jaeger), WebMCP, rekomendacje](docs/analysis.md)
- [Wyniki testów](docs/test-results.md)
