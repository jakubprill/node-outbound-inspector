# Przykład: monorepo z dwiema aplikacjami Next.js

Dwie aplikacje (`@acme/web`, `@acme/admin`) uruchamiane równolegle, tak jak `turbo dev` / npm workspaces. Każda ma własny port inspektora.

| Aplikacja | Port HTTP | Port inspektora | Strony |
|---|---|---|---|
| `@acme/web` | 3101 | 9231 | `/seq` (3 × `await`, waterfall), `/err` (integracja zwraca 500) |
| `@acme/admin` | 3102 | 9241 | `/par` (`Promise.all`), `/seq` (2 × `await`) |

## Uruchomienie
```bash
npm install
npm run mock          # terminal 1 — udawane serwisy na :4001 (?ms=opóźnienie, ?status=kod)
npm run dev:inspect   # terminal 2 — obie aplikacje z inspekcją sieci
npm run demo          # terminal 3 — serwer MCP + ruch na wszystkich stronach + analiza
```

`npm install` podłącza narzędzie z tego repozytorium (`"node-outbound-inspector": "file:../.."` w `devDependencies`), więc w skryptach aplikacji jest dostępne polecenie `outbound-next`:
```jsonc
// apps/web/package.json
"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
```
W prawdziwym monorepo zamiast `file:../..` jest zależność z gita przypięta do tagu (`github:jakubprill/node-outbound-inspector#<tag>`).

### Windows
Skrypty `dev:inspect` aplikacji działają w `cmd.exe` i PowerShell. Skrypty zbiorcze w katalogu głównym (`dev`, `dev:inspect` z `&` i `wait`, `demo` z `APPS=…`) wymagają powłoki POSIX (np. Git Bash). W PowerShell:
```powershell
npm run dev:inspect -w @acme/web     # terminal 2
npm run dev:inspect -w @acme/admin   # terminal 3
$env:APPS='[{"app":"@acme/web","url":"http://localhost:3101","pages":["/seq","/err"]},{"app":"@acme/admin","url":"http://localhost:3102","pages":["/par","/seq"]}]'
node ../../scripts/mcp-demo.mjs      # terminal 4 (PowerShell)
```
W monorepo z turbo równoległe uruchamianie zapewnia `turbo run dev:inspect`.

Oczekiwany wynik `npm run demo` (wartości przybliżone):
```
[@acme/web]   GET /seq  3 req., ~470 ms → SEQUENTIAL (waterfall) | potential saving ~310 ms
[@acme/web]   GET /err  1 req.          → error: POST …/payments → 500
[@acme/admin] GET /par  3 req., ~160 ms → PARALLEL
[@acme/admin] GET /seq  2 req., ~320 ms → SEQUENTIAL (waterfall) | potential saving ~160 ms
```

Podgląd w Chrome: `chrome://inspect` → *Configure…* → dodaj `localhost:9231` i `localhost:9241` → **inspect** przy wybranej aplikacji → zakładka **Network**.

## Na co zwrócić uwagę
- Gdyby obie aplikacje miały gołe `--inspect` (domyślny port 9229), druga wypisałaby tylko `Starting inspector on 127.0.0.1:9229 failed: address already in use` i działałaby dalej bez inspektora. Dlatego każda ma własny port.
- `outbound-next` znajduje `next` przez `require.resolve('next/dist/bin/next')` z katalogu aplikacji, niezależnie od tego, gdzie menedżer pakietów go umieścił (npm/pnpm/yarn/bun). Dawny zapis `$(node -p "require.resolve(…)")` w skrypcie wymaga powłoki POSIX, więc nie działa w `cmd.exe`, w którym npm i pnpm uruchamiają skrypty na Windows.
