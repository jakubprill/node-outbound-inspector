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
