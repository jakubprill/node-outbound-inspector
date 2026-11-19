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

Oczekiwany wynik `npm run demo` (wartości przybliżone):
```
[@acme/web]   GET /seq  3 zap., ~470 ms → SEKWENCYJNIE (waterfall) | możliwa oszczędność ~310 ms
[@acme/web]   GET /err  1 zap.          → błąd: POST …/payments → 500
[@acme/admin] GET /par  3 zap., ~160 ms → RÓWNOLEGLE
[@acme/admin] GET /seq  2 zap., ~320 ms → SEKWENCYJNIE (waterfall) | możliwa oszczędność ~160 ms
```

Podgląd w Chrome: `chrome://inspect` → *Configure…* → dodaj `localhost:9231` i `localhost:9241` → **inspect** przy wybranej aplikacji → zakładka **Network**.

## Na co zwrócić uwagę
- Gdyby obie aplikacje miały gołe `--inspect` (domyślny port 9229), druga wypisałaby tylko `Starting inspector on 127.0.0.1:9229 failed: address already in use` i działałaby dalej bez inspektora. Dlatego każda ma własny port.
- `require.resolve('next/dist/bin/next')` znajduje `next` niezależnie od tego, gdzie menedżer pakietów go umieścił (npm/pnpm/yarn). Składnia `$(...)` wymaga powłoki POSIX, więc nie działa w Windowsowym cmd.
