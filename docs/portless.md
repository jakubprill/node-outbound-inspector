# portless (vercel-labs/portless) a node-outbound-inspector — test (2026-11-20)

[portless](https://github.com/vercel-labs/portless) zastępuje porty nazwanymi adresami
(`http://web.localhost:1355`, domyślnie `https://web.localhost`). Uruchamia polecenie z `PORT`
(losowy 4000–4999), `HOST=127.0.0.1`, `PORTLESS_URL` i (przy HTTPS) `NODE_EXTRA_CA_CERTS`,
a ruch z przeglądarki przepuszcza przez własne proxy. Z korzenia monorepo (`portless`) startuje
skrypt `dev` (albo `--script <nazwa>`) każdej paczki workspace.

## Wniosek

**Działa.** portless dotyczy portu HTTP aplikacji, a nasze narzędzie portu inspektora — to dwa
niezależne kanały. Proxy portless nie stoi na drodze ani do inspektora, ani do zapytań wychodzących.
Warunek: każda aplikacja dalej musi mieć **własny, jawny port inspektora**.

## Środowisko testu

MacBook (Apple Silicon), Node 26.12.0, Next 16.4.0 (Turbopack), portless 0.18.1 (bez TLS, bez sudo:
`PORTLESS_HTTPS=0 PORTLESS_PORT=1355 PORTLESS_UNPRIVILEGED=1`), monorepo npm workspaces
z dwiema aplikacjami (`@acme/web`, `@acme/admin`), outbound-hub i kolektor MCP z bieżącego `main`.

Skrypty aplikacji (bez `--port` — port daje portless):

```json
"portless": { "name": "web" },
"scripts": { "dev:portless": "outbound-next dev --inspect=9231" }
```

Start całego monorepo: `portless --script dev:portless`.

## Wyniki

| Sprawdzenie | Wynik |
|---|---|
| portless z korzenia monorepo uruchamia obie aplikacje przez `outbound-next` | ✅ `web.localhost:1355 → :4653`, `admin.localhost:1355 → :4028` |
| outbound-hub (`chrome://inspect`) widzi obie aplikacje | ✅ `@acme/web` (9231), `@acme/admin` (9241) |
| Kolektor MCP: inspekcja sieci i przypisanie do żądań stron | ✅ `net=true corr=true`, bez ostrzeżeń |
| `http_ports` | ✅ pokazuje losowe porty od portless (`[4653]`, `[4028]`) — mapowanie na `portless list` |
| Żądania stron przez proxy (`Host: web.localhost:1355`) | ✅ zapytania przypisane do `GET /seq`, analiza „sequential” jak bez portless |
| Serwer Next woła inną usługę po nazwie (`http://mock.localhost:1355/user`, alias portless) | ✅ zapisane z nazwanym URL-em, odpowiedź z nagłówkiem `X-Portless: 1` |
| `*.localhost` w Node na macOS | ✅ `dns.lookup` zwraca `::1` i `127.0.0.1`, `fetch` działa |
| `--inspect` bez portu, jedna aplikacja | ⚠️ inspektor na 9229 — poza domyślnym zakresem kolektora (9230–9249) i na porcie huba |
| `--inspect` bez portu, dwie aplikacje (jak `portless -- --inspect`) | ❌ druga: `Starting inspector on 127.0.0.1:9229 failed: address already in use`, działa bez inspektora (tylko linia w logu) |

Uwaga do testu: żądania RSC wysłane surowym `http.request` dostały `307` (Next przekierowuje na adres
z `?_rsc=`, a `http.request` nie podąża za przekierowaniem). To cecha Next, nie portless —
`fetch` z poprzednich testów podążał za przekierowaniem i dostawał 200.

## Co z tego wynika dla użytkowników

1. Usuń `--port` ze skryptu, gdy uruchamiasz przez portless (Next czyta `PORT`). Zostaw `--inspect=<port>`
   z osobnym portem dla każdej aplikacji (9230–9249).
2. Nie używaj `portless -- --inspect` ani `next dev --inspect` bez portu w monorepo: wszystkie aplikacje
   chcą 9229, wygrywa jedna, reszta po cichu działa bez inspektora; 9229 to też port huba.
3. HTTPS portless (domyślny) nie zmienia nic po stronie inspektora; zapytania serwera do `https://*.localhost`
   działają dzięki `NODE_EXTRA_CA_CERTS`, które portless ustawia dzieciom. (Nie testowane — test był bez TLS.)

## Możliwe usprawnienia

- **Nazwa aplikacji z portless:** gdy proces ma `PORTLESS_URL`, nazwać aplikację tak jak portless (`web`),
  zamiast `@acme/web`. Łączy się z issue #8 (nazwy bez scope npm).
- **`--inspect=auto` w `outbound-next`:** wolny port z zakresu `INSPECTOR_PORTS`, wybierany deterministycznie
  po nazwie pakietu (ten sam port przy każdym starcie), żeby skrypty nie musiały pilnować portów ręcznie.
  Wyścig przy równoczesnym starcie trzeba obsłużyć (sprawdzenie zajętości + kolejny port).
- **Ostrzeżenie w `outbound-next`**, gdy `--inspect` nie ma portu (9229 = port huba, poza zakresem kolektora).

Skrypty testu: `monorepo/run-portless.command`, `monorepo/tools/portless-check.mjs` (poza repo, na Macu).
