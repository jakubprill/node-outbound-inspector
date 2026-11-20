# portless (vercel-labs/portless) and node-outbound-inspector — test (2026-11-20)

[portless](https://github.com/vercel-labs/portless) replaces ports with named addresses
(`http://web.localhost:1355`, `https://web.localhost` by default). It runs the command with `PORT`
(random 4000–4999), `HOST=127.0.0.1`, `PORTLESS_URL` and (with HTTPS) `NODE_EXTRA_CA_CERTS`,
and routes browser traffic through its own proxy. From the monorepo root (`portless`) it starts
the `dev` script (or `--script <name>`) of every workspace package.

## Conclusion

**It works.** portless deals with the app's HTTP port, our tool with the inspector port — two
independent channels. The portless proxy is in the way neither of the inspector nor of outbound requests.
Condition: every app still needs **its own, explicit inspector port**.

## Test environment

MacBook (Apple Silicon), Node 26.12.0, Next 16.4.0 (Turbopack), portless 0.18.1 (no TLS, no sudo:
`PORTLESS_HTTPS=0 PORTLESS_PORT=1355 PORTLESS_UNPRIVILEGED=1`), npm workspaces monorepo
with two apps (`@acme/web`, `@acme/admin`), outbound-hub and the MCP collector from current `main`.

App scripts (no `--port` — portless provides the port):

```json
"portless": { "name": "web" },
"scripts": { "dev:portless": "outbound-next dev --inspect=9231" }
```

Starting the whole monorepo: `portless --script dev:portless`.

## Results

| Check | Result |
|---|---|
| portless from the monorepo root starts both apps through `outbound-next` | ✅ `web.localhost:1355 → :4653`, `admin.localhost:1355 → :4028` |
| outbound-hub (`chrome://inspect`) sees both apps | ✅ `@acme/web` (9231), `@acme/admin` (9241) — before 0.7.0; now `web`, `admin` |
| MCP collector: network inspection and page assignment | ✅ `net=true corr=true`, no warnings |
| `http_ports` | ✅ shows the random ports from portless (`[4653]`, `[4028]`) — maps to `portless list` |
| Page requests through the proxy (`Host: web.localhost:1355`) | ✅ requests assigned to `GET /seq`, "sequential" analysis as without portless |
| The Next server calls another service by name (`http://mock.localhost:1355/user`, portless alias) | ✅ recorded with the named URL, response with the `X-Portless: 1` header |
| `*.localhost` in Node on macOS | ✅ `dns.lookup` returns `::1` and `127.0.0.1`, `fetch` works |
| `--inspect` without a port, one app | ⚠️ inspector on 9229 — outside the collector's default range (9230–9249) and on the hub's port |
| `--inspect` without a port, two apps (like `portless -- --inspect`) | ❌ the second: `Starting inspector on 127.0.0.1:9229 failed: address already in use`, runs without an inspector (only a log line) |

Note on the test: RSC requests sent with a raw `http.request` got `307` (Next redirects to an address
with `?_rsc=`, and `http.request` does not follow redirects). This is Next behavior, not portless —
`fetch` in earlier tests followed the redirect and got 200.

## What this means for users

1. Remove `--port` from the script when running through portless (Next reads `PORT`). Keep `--inspect=<port>`
   with a separate port for every app (9230–9249).
2. Do not use `portless -- --inspect` or `next dev --inspect` without a port in a monorepo: all apps
   want 9229, one wins, the rest silently run without an inspector; 9229 is also the hub's port.
3. portless HTTPS (the default) changes nothing on the inspector side; server requests to `https://*.localhost`
   work thanks to `NODE_EXTRA_CA_CERTS`, which portless sets for children. (Not tested — the test ran without TLS.)

## Possible improvements

- ~~**App name from portless:** when the process has `PORTLESS_URL`, name the app as portless does (`web`)
  instead of `@acme/web`. Ties in with issue #8 (names without the npm scope).~~ Done in 0.7.0.
- **`--inspect=auto` in `outbound-next`:** a free port from the `INSPECTOR_PORTS` range, chosen deterministically
  by package name (the same port on every start), so scripts do not have to manage ports by hand.
  The race on simultaneous starts must be handled (check if taken + next port).
- ~~**A warning in `outbound-next`** when `--inspect` has no port (9229 = the hub's port, outside the collector's range).~~ Done in 0.7.0.

Test scripts: `monorepo/run-portless.command`, `monorepo/tools/portless-check.mjs` (outside the repo, on the Mac).
