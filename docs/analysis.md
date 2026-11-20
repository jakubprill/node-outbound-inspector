# Next.js: inspekcja ruchu sieciowego po stronie serwera (Chrome DevTools + MCP dla agentów)

_Analiza i wyniki testów · stan na 2026-11-19_

## Spis treści
1. [Problem](#1-problem)
2. [Rozwiązanie bazowe: inspekcja sieci w Node](#2-rozwiązanie-bazowe-inspekcja-sieci-w-node)
3. [Wyniki testów](#3-wyniki-testów)
4. [Pułapki](#4-pułapki)
5. [Monorepo: kilka aplikacji naraz](#5-monorepo-kilka-aplikacji-naraz)
6. [Agent AI: serwer MCP `outbound-mcp`](#6-agent-ai-serwer-mcp-outbound-mcp)
7. [WebMCP i Chrome DevTools MCP: co pasuje, a co nie](#7-webmcp-i-chrome-devtools-mcp-co-pasuje-a-co-nie)
8. [Alternatywy](#8-alternatywy)
9. [Rekomendacja i kroki wdrożenia](#9-rekomendacja-i-kroki-wdrożenia)
10. [Ograniczenia i bezpieczeństwo](#10-ograniczenia-i-bezpieczeństwo)

---

## 1. Problem
W aplikacji Next.js większość wywołań do integracji wykonuje serwer (Node), a nie przeglądarka. Dlatego nie widać ich w zakładce **Network** w Chrome DevTools. Celem jest podgląd tego ruchu w trybie deweloperskim (URL, nagłówki, status, treść, czasy) oraz automatyczna analiza: błędy, zapytania sekwencyjne i równoległe.

## 2. Rozwiązanie bazowe: inspekcja sieci w Node
Node ma wbudowaną, eksperymentalną flagę `--experimental-network-inspection`, która wysyła zdarzenia `Network.*` protokołu Chrome DevTools (CDP) dla `fetch` (undici), `node:http`/`https` oraz HTTP/2.

```json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --inspect"
```

Zapis `$(…)` wymaga powłoki POSIX; na Windows (`cmd.exe`) użyj `outbound-next dev --inspect` albo ścieżki `./node_modules/next/dist/bin/next` (README, „Szybki start”).

Użycie:
1. `npm run dev:inspect`
2. Chrome → `chrome://inspect` → **Open dedicated DevTools for Node** → zakładka **Network**
3. Otwórz aplikację. Wywołania serwera pojawiają się w tym osobnym oknie DevTools.

## 3. Wyniki testów
Środowisko: MacBook (Apple Silicon), Next.js 16.4.0, testy wykonane 2026-11-18/19.

| Środowisko | `fetch` (undici) | `node:http` (axios/got) |
|---|---|---|
| Node 26.12 + Next 16.4 **Turbopack** | ✅ URL, nagłówki, status, treść | ✅ pełne |
| Node 26.12 + Next 16.4 webpack | ✅ pełne | ✅ pełne |
| Node 22.23 (bez Next) | ⚠️ brak treści odpowiedzi | ✅ pełne |
| Bun 1.4 jako runtime | ❌ (WebKit Inspector, nie CDP) | ❌ |

- W trybie dev Next 16 działa w **jednym procesie** z inspektorem, więc wystarczy jedno podłączenie.
- Okno Chrome DevTools i agent (MCP) mogą być podłączone **jednocześnie** i oba widzą te same zdarzenia.

## 4. Pułapki
- ❌ `NODE_OPTIONS='--experimental-network-inspection'` **nie działa**: Node odrzuca tę flagę w `NODE_OPTIONS`. Trzeba ją przekazać bezpośrednio do `node`.
- `--inspect` podajemy jako argument `next dev`.
- Wymagany **Node ≥ 24**. Na Node 22 brakuje treści odpowiedzi z `fetch`.
- Funkcja jest eksperymentalna i może się zmieniać między wersjami Node.
- Ruch serwera jest w **osobnym** oknie DevTools, nie razem z ruchem strony.
- Next sam odpytuje `registry.npmjs.org` (sprawdzanie aktualizacji). Wystarczy to odfiltrować.
- Bun jako runtime (`bun --bun next dev`) nie jest obsługiwany. Zostaje `BUN_CONFIG_VERBOSE_FETCH=curl`. Jeśli Bun służy tylko do instalowania pakietów i uruchamiania skryptów, a Next działa na Node, wszystko działa.
- Docker: w kontenerze `--inspect=0.0.0.0:<port>` (z `outbound-next` wymaga `OUTBOUND_ALLOW_REMOTE_INSPECT=1`), a port wystawiony **tylko na pętli zwrotnej hosta**: `-p 127.0.0.1:<port>:<port>`. Samo `-p <port>:<port>` wystawia inspektor, czyli wykonanie kodu w procesie, każdemu w sieci. Edge runtime nie jest objęty.

## 5. Monorepo: kilka aplikacji naraz
**Problem:** przy równoległym `dev` (turbo / workspaces) wszystkie aplikacje próbują zająć port 9229.

| Scenariusz | Wynik |
|---|---|
| A: każda aplikacja z gołym `--inspect` | ❌ Pierwsza zajmuje 9229. Druga wypisuje tylko `Starting inspector on 127.0.0.1:9229 failed: address already in use` i **działa dalej bez inspektora**. Next pokazuje „Debugger port” tylko przy pierwszej, więc łatwo to przeoczyć. Obie aplikacje mają ten sam `next` z `node_modules`, więc w inspektorze wyglądają identycznie. |
| B: osobny port na aplikację | ✅ Obie widoczne, a jeden serwer MCP rozróżnia je poprawnie. |

**Konfiguracja (każda aplikacja ma własny port inspektora):**
```jsonc
// apps/web/package.json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --port 3101 --inspect=9231"
// apps/admin/package.json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --port 3102 --inspect=9241"
// package.json (root) — równolegle, jak `dev`
"dev:inspect": "npm run dev:inspect -w @acme/web & npm run dev:inspect -w @acme/admin & wait"
```
`require.resolve` znajduje `next` niezależnie od tego, gdzie menedżer pakietów go umieścił (wersja hoisted albo pnpm). Składnia `$(...)` nie działa w Windowsowym cmd. Przenośny zapis, niezależny od powłoki: `"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"` (README, „Szybki start”; issue #5).

**Wynik testu (2 × Next 16.4 Turbopack uruchomione równolegle, ruch generowany jednocześnie w obu):**

| Aplikacja | Strona | Zapytania | Czas | Werdykt |
|---|---|---|---|---|
| `@acme/web` | `GET /seq` | 3 | 469 ms | SEKWENCYJNIE, możliwa oszczędność 313 ms |
| `@acme/web` | `GET /err` | 1 | 89 ms | błąd 500 z `/payments` |
| `@acme/admin` | `GET /par` | 3 | 163 ms | RÓWNOLEGLE |
| `@acme/admin` | `GET /seq` | 2 | 320 ms | SEKWENCYJNIE, możliwa oszczędność 161 ms |

Ten sam URL (`/user`) wołany przez obie aplikacje w tej samej chwili został poprawnie przypisany do każdej z nich.

## 6. Agent AI: serwer MCP `outbound-mcp`
Prototyp serwera MCP (jeden plik `src/outbound-mcp.mjs`, bez zależności, Node ≥ 22). Podłącza się do inspektorów Node i daje agentowi (Claude Code, Cursor, Copilot…) dostęp do ruchu serwera razem z analizą.

**Narzędzia:**
| Narzędzie | Opis |
|---|---|
| `inspector_status` | Podłączone aplikacje: nazwa, port, pid, katalog |
| `list_server_requests` | Zapytania: aplikacja, strona, metoda, URL, status, czas |
| `get_server_request` | Nagłówki żądania i odpowiedzi, treść, stos wywołań |
| `analyze_server_timeline` | Osobno dla każdej aplikacji i każdego żądania strony: wykrywa zapytania sekwencyjne i równoległe, liczy zysk z `Promise.all` i zbiera błędy |
| `clear_server_requests` | Czyści bufor (całość albo jedną aplikację) |

**Jak działa:**
- Skanuje porty inspektorów (domyślnie `9229-9249`) i podłącza się do każdego procesu.
- **Rozpoznaje aplikację:** odczytuje z procesu jego katalog roboczy i nazwę pakietu, a dodatkowo `name` z `package.json`. Można to nadpisać zmienną `APP_NAMES`.
- **Przypisuje zapytanie do strony:** wstrzykuje do procesu mały kod nasłuchujący (`diagnostics_channel` i `AsyncLocalStorage`), który zapamiętuje, które przychodzące żądanie strony wywołało dane zapytanie. Dzięki temu równoległe renderowanie kilku stron się nie miesza. W kodzie aplikacji nic nie trzeba zmieniać.

**Podłączenie:**
```bash
claude mcp add outbound -- node /ścieżka/node-outbound-inspector/src/outbound-mcp.mjs
# opcjonalnie: -e INSPECTOR_PORTS=9231,9241 -e APP_NAMES=9231=web,9241=admin
```

**Zalecany przebieg pracy agenta:** `clear_server_requests` → otwarcie strony (np. przez Chrome DevTools MCP) → `analyze_server_timeline` → `get_server_request` dla błędów.

## 7. WebMCP i Chrome DevTools MCP: co pasuje, a co nie
- **WebMCP** (`document.modelContext`, dawniej `navigator.modelContext`) służy do czegoś innego: strona udostępnia przez nie **swoje akcje** agentowi w przeglądarce. Nie daje dostępu do ruchu serwera. Na razie jest dostępne tylko w Chrome, w ramach origin trial. **Nie nadaje się do tego celu.**
- **Chrome DevTools MCP** (oficjalny, Google) obsługuje stronę w przeglądarce: nawigację, Network, konsolę i wydajność. Do procesu Node się nie podłącza. **Dobrze uzupełnia `outbound-mcp`:** razem dają agentowi pełny obraz jednego żądania, od przeglądarki po serwer.

## 8. Alternatywy
- **Proxy przechwytujące** (HTTP Toolkit, mitmproxy, Proxyman): jeden widok na ruch przeglądarki i serwera, działa niezależnie od runtime'u. Wymaga przekierowania undici (`setGlobalDispatcher(new ProxyAgent(...))`) oraz `http`/`https`. Przy HTTPS dodaj `NODE_EXTRA_CA_CERTS`.
- **`node-network-devtools`** (npm): podgląd w Chrome DevTools przez `register()` w `instrumentation.ts`. Nie obsługuje Buna.
- **OpenTelemetry + Jaeger**: inny cel. Pokazuje czasy i przepływ między serwisami oraz działa na stagingu i produkcji. Next ma wbudowaną obsługę (`instrumentation.ts`, `@vercel/otel`). Domyślnie nie pokazuje treści żądań i odpowiedzi. **Uzupełnia inspekcję sieci, nie zastępuje jej.**

## 9. Rekomendacja i kroki wdrożenia
1. **Teraz:** dodać `dev:inspect` z osobnym portem inspektora dla każdej aplikacji w monorepo. Używać Node ≥ 24.
2. **Dla agentów:** `outbound-mcp` razem z Chrome DevTools MCP. Pilotaż na jednej prawdziwej stronie z monorepo.
3. **Do zrobienia w prototypie:** rozwiązywanie map źródeł (`.map` w `.next/dev`), żeby wskazywać pliki źródłowe zamiast skompilowanych chunków.
4. **Później, jeśli potrzebna będzie widoczność między serwisami i na środowiskach:** OpenTelemetry z Jaegerem (lokalnie kontener `jaegertracing/all-in-one`).

## 10. Ograniczenia i bezpieczeństwo
- W Next.js `fetch` jest opakowany przez sam Next (`dedupeFetch`), więc stos wywołań kończy się w jego wnętrzu. **Linii kodu strony nie widać.** Kod znajduje się po URL-u zapytania i po przypisanej stronie. Poza Next (zwykły Node) dokładna linia jest widoczna.
- Zapytania wykonywane poza kontekstem żądania strony (start serwera, zadania w tle) trafiają do grupy „bez strony”.
- Inspektor daje **pełną kontrolę nad procesem**, a `outbound-mcp` wstrzykuje do niego kod. To narzędzie **tylko do lokalnego developmentu**. Inspektor powinien zostać na domyślnym adresie `127.0.0.1` i nie może trafić na żadne współdzielone środowisko.
