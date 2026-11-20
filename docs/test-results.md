# Wyniki testów

Testy wykonane 2026-11-18/19 na MacBooku (Apple Silicon, macOS) oraz w kontenerze Linux.

## 1. Pojedyncza aplikacja Next.js — podgląd w Chrome DevTools

| Środowisko | `fetch` (undici) | `node:http` (axios/got) | Uwagi |
|---|---|---|---|
| Node 26.12 + Next 16.4.0 **Turbopack** | ✅ URL, nagłówki, status, treść | ✅ pełne | jeden proces z inspektorem |
| Node 26.12 + Next 16.4.0 webpack | ✅ pełne | ✅ pełne | jeden proces z inspektorem |
| Node 22.23 (bez Next) | ⚠️ brak treści odpowiedzi | ✅ pełne | |
| Bun 1.4.4 jako runtime | ❌ | ❌ | WebKit Inspector, brak `/json/list` dla Chrome |

- `NODE_OPTIONS='--experimental-network-inspection'` → `node: --experimental-network-inspection is not allowed in NODE_OPTIONS`.
- Dwa klienty CDP podłączone jednocześnie (np. DevTools i agent) dostają te same zdarzenia.

## 2. Serwer MCP — pojedyncza aplikacja (Next 16.4.0, Turbopack)

| Strona | Zapytania | Czas | Werdykt |
|---|---|---|---|
| 3 × `await fetch` po kolei | 3 | 483 ms | SEKWENCYJNIE, możliwa oszczędność 321 ms |
| `Promise.all` z tymi samymi zapytaniami | 3 | 171 ms | RÓWNOLEGLE |
| integracja zwraca 500 | 1 | ~89 ms | błąd wychwycony z nagłówkami |

Stos wywołań w Next.js kończy się na wewnętrznym `dedupeFetch` / `doOriginalFetch` (Next opakowuje `fetch`), więc linia strony nie jest dostępna. W czystym Node linia jest widoczna, np. `errorPage @ scenario-app.mjs:9`. Asynchroniczne stosy debuggera (`Debugger.setAsyncCallStackDepth`) **nie** rozszerzają stosu w zdarzeniach sieciowych.

## 3. Monorepo — dwie aplikacje Next.js 16.4.0 (Turbopack) uruchomione równolegle (npm workspaces)

**Scenariusz A — obie z `--inspect`:**
```
Debugger listening on ws://127.0.0.1:9229/...
Starting inspector on 127.0.0.1:9229 failed: address already in use
- Local:         http://localhost:3102
- Local:         http://localhost:3101
- Debugger port: 9229
```
Druga aplikacja działa bez inspektora. Next wypisuje „Debugger port” tylko przy pierwszej.

**Scenariusz B — osobne porty (9231, 9241) + jeden serwer MCP, ruch we wszystkich stronach jednocześnie:**

| Aplikacja | Strona | Zapytania | Czas | Werdykt |
|---|---|---|---|---|
| `@acme/web` | `GET /seq` | 3 | 469 ms | SEKWENCYJNIE, oszczędność 313 ms |
| `@acme/web` | `GET /err` | 1 | 89 ms | błąd 500 z `/payments` |
| `@acme/admin` | `GET /par` | 3 | 163 ms | RÓWNOLEGLE |
| `@acme/admin` | `GET /seq` | 2 | 320 ms | SEKWENCYJNIE, oszczędność 161 ms |

Ten sam URL (`/user`) wołany w tej samej chwili przez obie aplikacje i przez dwie strony jednej aplikacji został za każdym razem przypisany poprawnie.

## 4. Testy automatyczne (`npm test`)
`test/e2e.test.mjs` odtwarza scenariusz B bez Next.js (dwa procesy Node z różnymi portami inspektora). Sprawdza rozpoznanie aplikacji, przypisanie do aplikacji i strony (także `node:http`), werdykty, błędy, nagłówki i filtry. Wynik: 5/5, stabilnie w kolejnych uruchomieniach.

## 5. M2 — poprawki wad i treści odpowiedzi (2026-11-19)

| Środowisko | Testy | Wynik |
|---|---|---|
| Linux, Node 22.23.5 | 82 | 80 zielonych, 2 `todo` (wady 1 i 5 → M4, M6) |
| macOS (Apple Silicon), Node 26.12.0 | 84 (+2 dla nagrania z Node 26) | 82 zielone, 2 `todo` |

- **Wada 2:** status bez flagi pokazuje `network_inspection: false` i powód w `warnings`.
- **Wada 3:** po restarcie aplikacji na tym samym porcie widać 6 rekordów, nie 3.
- **Wada 4:** na Node 22 treść `fetch` ma stan `unavailable` z powodem, a na Node 26 jest dostępna. Potwierdzone na nagraniach z obu wersji.
- **Wada 6:** wartość `Bearer secret-token` nie występuje w wyniku żadnego narzędzia.
- **Limit bufora:** przy limicie 32 MB najstarsza z 40 odpowiedzi po 2 MB znika z procesu aplikacji (tryb `lazy` → `evicted`), a w trybie `eager` jej treść zostaje pobrana wcześniej. Działa na Node 22 i 26.
- **Wyścig ujawniony na Macu:** status mógł pokazać proces przed zakończeniem jego identyfikacji. Naprawione polem `ready`.
- **Pułapka w testach:** porty 5060/5061 są blokowane przez `fetch` (SIP). Testy ich nie używają.

## 6. Node 24 jako minimum (2026-11-19)

| Środowisko | Testy | Wynik |
|---|---|---|
| Linux, Node 24.22.3 | 160 | 158 zielonych, 2 `todo` (wady 1 i 5 → M4, M6), dwa kolejne przebiegi |

- **Błąd Node nodejs/node#66551:** aplikacja czytająca odpowiedź `node:http` po `res.setEncoding()` przy podłączonym kolektorze dostawała `TypeError: Missing dataLength in event` i nie dostawała odpowiedzi. Test `test/e2e/node-fixes.test.mjs` bez obejścia kończy się przekroczeniem czasu, z obejściem przechodzi (proces żyje, treść `available`, `node_workarounds: ["nodejs/node#66551"]`).
- Niezweryfikowane po zmianie: kodowanie znaków przy gzip w `fetch` na Node ≥ 24 (wcześniej sprawdzone tylko na Node 22).

## 7. M6 — budżet odpowiedzi, kursor, settle, redakcja treści, era MCP 2026-07-28 (2026-11-19)

| Środowisko | Testy | Wynik |
|---|---|---|
| Linux, Node 24.22.3 | 175 | 174 zielone, 1 `todo` (wada 1 → M4) |

- **Wada 5 naprawiona:** 44 strony × 3 zapytania przez prawdziwy inspektor; podsumowanie ≤ 6000 znaków, pełny raport i lista ≤ 20 000.
- **Test własności:** losowe magazyny 0–5000 zapytań, limity 20 000 i 6000; każdy wynik każdego narzędzia to poprawny JSON w limicie.
- **Kursor:** przejście przez 1200 rekordów z różnymi `limit` i budżetem zwraca każdy rekord dokładnie raz.
- **settle_ms:** analiza wywołana 80 ms po wejściu na stronę z trzema zapytaniami po 150 ms: bez `settle_ms` 0 żądań stron i 1 zapytanie w toku, z `settle_ms: 300` komplet trzech.
- **Redakcja treści:** `access_token` z odpowiedzi serwisu nie występuje w żadnym wyniku żadnego narzędzia; przy `OUTBOUND_REDACT=0` jest widoczny.
- **Protokół:** klient bez `initialize` (tylko era 2026-07-28) dostaje `server/discover` i wynik `tools/call` przez stdio.

## 8. outbound-hub i współpraca z Next DevTools MCP (2026-11-20)

| Środowisko | Wynik |
|---|---|
| Linux, Chrome 153 (headless), Node 24.22.3 | `chrome://inspect` w domyślnej konfiguracji pokazuje przez hub obie aplikacje z nazwami pod `localhost:9229`; „inspect” otwiera DevTools połączone z właściwym procesem |
| macOS, Next 16.4.0 (Turbopack), Node 26.12, monorepo z dwiema aplikacjami przez `outbound-next` | hub: obie aplikacje z nazwami; `http_ports` = [3101] i [3102] (bez portów inspektora); żądania RSC z nagłówkami Next mają `next_request_id` / `next_html_request_id`, filtr działa; `get_request_insights({ requestId })` zwraca to samo żądanie (złączenie działa); `/_next/mcp` nie jest żądaniem strony; `next-devtools-mcp` 0.4.0 znajduje obie aplikacje bez podawania portu |

- Wymóg `chrome://inspect` znaleziony testem: odpowiedź z `Content-Length` (bez `chunked`) i `Browser: node.js/…` w `/json/version`; bez tego Chrome odpytuje hub, ale nie pokazuje celów.
- Pełny zestaw: 182 testy, 181 zielonych, 1 `todo` (wada 1 → M4).

