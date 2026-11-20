# Test results

Tests run on 2026-11-18/19 on a MacBook (Apple Silicon, macOS) and in a Linux container.

## 1. A single Next.js app — viewing in Chrome DevTools

| Environment | `fetch` (undici) | `node:http` (axios/got) | Notes |
|---|---|---|---|
| Node 26.12 + Next 16.4.0 **Turbopack** | ✅ URL, headers, status, body | ✅ complete | one process with the inspector |
| Node 26.12 + Next 16.4.0 webpack | ✅ complete | ✅ complete | one process with the inspector |
| Node 22.23 (no Next) | ⚠️ no response body | ✅ complete | |
| Bun 1.4.4 as the runtime | ❌ | ❌ | WebKit Inspector, no `/json/list` for Chrome |

- `NODE_OPTIONS='--experimental-network-inspection'` → `node: --experimental-network-inspection is not allowed in NODE_OPTIONS`.
- Two CDP clients attached at once (e.g. DevTools and an agent) get the same events.

## 2. MCP server — a single app (Next 16.4.0, Turbopack)

| Page | Requests | Time | Verdict |
|---|---|---|---|
| 3 × `await fetch` one after another | 3 | 483 ms | SEQUENTIAL, possible saving 321 ms |
| `Promise.all` with the same requests | 3 | 171 ms | PARALLEL |
| integration returns 500 | 1 | ~89 ms | error caught with headers |

In Next.js the call stack ends in the internal `dedupeFetch` / `doOriginalFetch` (Next wraps `fetch`), so the page line is not available. In plain Node the line is visible, e.g. `errorPage @ scenario-app.mjs:9`. Debugger async stacks (`Debugger.setAsyncCallStackDepth`) do **not** extend the stack in network events.

## 3. Monorepo — two Next.js 16.4.0 apps (Turbopack) started in parallel (npm workspaces)

**Scenario A — both with `--inspect`:**
```
Debugger listening on ws://127.0.0.1:9229/...
Starting inspector on 127.0.0.1:9229 failed: address already in use
- Local:         http://localhost:3102
- Local:         http://localhost:3101
- Debugger port: 9229
```
The second app runs without an inspector. Next prints "Debugger port" only for the first one.

**Scenario B — separate ports (9231, 9241) + one MCP server, traffic on all pages at once:**

| App | Page | Requests | Time | Verdict |
|---|---|---|---|---|
| `@acme/web` | `GET /seq` | 3 | 469 ms | SEQUENTIAL, saving 313 ms |
| `@acme/web` | `GET /err` | 1 | 89 ms | 500 error from `/payments` |
| `@acme/admin` | `GET /par` | 3 | 163 ms | PARALLEL |
| `@acme/admin` | `GET /seq` | 2 | 320 ms | SEQUENTIAL, saving 161 ms |

The same URL (`/user`) called at the same moment by both apps and by two pages of one app was assigned correctly every time.

## 4. Automated tests (`npm test`)
`test/e2e.test.mjs` reproduces scenario B without Next.js (two Node processes with different inspector ports). It checks app recognition, assignment to app and page (also `node:http`), verdicts, errors, headers and filters. Result: 5/5, stable across runs.

## 5. M2 — defect fixes and response bodies (2026-11-19)

| Environment | Tests | Result |
|---|---|---|
| Linux, Node 22.23.5 | 82 | 80 green, 2 `todo` (defects 1 and 5 → M4, M6) |
| macOS (Apple Silicon), Node 26.12.0 | 84 (+2 for the Node 26 recording) | 82 green, 2 `todo` |

- **Defect 2:** the status without the flag shows `network_inspection: false` and the reason in `warnings`.
- **Defect 3:** after an app restart on the same port, 6 records are visible, not 3.
- **Defect 4:** on Node 22 the `fetch` body has state `unavailable` with a reason, and on Node 26 it is available. Confirmed on recordings from both versions.
- **Defect 6:** the value `Bearer secret-token` appears in no tool result.
- **Buffer limit:** with a 32 MB limit, the oldest of 40 responses of 2 MB each disappears from the app process (mode `lazy` → `evicted`), while in `eager` mode its body is fetched earlier. Works on Node 22 and 26.
- **Race found on the Mac:** the status could show a process before its identification finished. Fixed with the `ready` field.
- **Test trap:** ports 5060/5061 are blocked by `fetch` (SIP). The tests do not use them.

## 6. Node 24 as the minimum (2026-11-19)

| Environment | Tests | Result |
|---|---|---|
| Linux, Node 24.22.3 | 160 | 158 green, 2 `todo` (defects 1 and 5 → M4, M6), two consecutive runs |

- **Node bug nodejs/node#66551:** an app reading a `node:http` response after `res.setEncoding()` with the collector attached got `TypeError: Missing dataLength in event` and no response. `test/e2e/node-fixes.test.mjs` times out without the workaround and passes with it (the process lives, body `available`, `node_workarounds: ["nodejs/node#66551"]`).
- Not verified after the change: character encoding with gzip in `fetch` on Node ≥ 24 (previously checked only on Node 22).

## 7. M6 — response budget, cursor, settle, body redaction, MCP 2026-07-28 era (2026-11-19)

| Environment | Tests | Result |
|---|---|---|
| Linux, Node 24.22.3 | 175 | 174 green, 1 `todo` (defect 1 → M4) |

- **Defect 5 fixed:** 44 pages × 3 requests through a real inspector; summary ≤ 6000 characters, full report and list ≤ 20,000.
- **Property test:** random stores of 0–5000 requests, limits 20,000 and 6000; every result of every tool is valid JSON within the limit.
- **Cursor:** walking 1200 records with various `limit` values and budgets returns every record exactly once.
- **settle_ms:** analysis called 80 ms after visiting a page with three requests of 150 ms each: without `settle_ms` 0 page requests and 1 request in flight, with `settle_ms: 300` all three.
- **Body redaction:** an `access_token` from a service response appears in no result of any tool; with `OUTBOUND_REDACT=0` it is visible.
- **Protocol:** a client without `initialize` (2026-07-28 era only) gets `server/discover` and a `tools/call` result over stdio.

## 8. outbound-hub and working with Next DevTools MCP (2026-11-20)

| Environment | Result |
|---|---|
| Linux, Chrome 153 (headless), Node 24.22.3 | `chrome://inspect` in its default configuration shows both apps with names through the hub under `localhost:9229`; "inspect" opens DevTools connected to the right process |
| macOS, Next 16.4.0 (Turbopack), Node 26.12, two-app monorepo via `outbound-next` | hub: both apps with names; `http_ports` = [3101] and [3102] (without inspector ports); RSC requests with Next headers have `next_request_id` / `next_html_request_id`, the filter works; `get_request_insights({ requestId })` returns the same request (the join works); `/_next/mcp` is not a page request; `next-devtools-mcp` 0.4.0 finds both apps without a port |

- A `chrome://inspect` requirement found by testing: a response with `Content-Length` (not `chunked`) and `Browser: node.js/…` in `/json/version`; without them Chrome polls the hub but shows no targets.
- Full suite: 182 tests, 181 green, 1 `todo` (defect 1 → M4).

## 9. portless, names without scope, hub API (2026-11-20)

- **portless 0.18.1 + Next 16.4 on the Mac** (monorepo, two apps, `portless --script dev:portless`): the hub and the collector see both apps, page assignment and analysis unchanged, `http_ports` = ports from portless, calls by name to `*.localhost` recorded. `--inspect` without a port: with two apps the second has no inspector (`address already in use`). Details: [portless.md](portless.md).
- **Names (issue #8):** unit tests `names.test.mjs` (source order, scope, portless, collisions, filter) and e2e `names.test.mjs` (collision of `@acme/web`/`@other/web` in the status, records and hub; name from `PORTLESS_URL`; `APP_NAME_STRIP_SCOPE=0`).
- **Hub API (issue #9):** e2e `hub-api.test.mjs` — import through `exports`, `listening` / `already-running` / `port-taken` with `holder`, idempotent `close()`, options as text; the same hub run under **Bun 1.4.4**: app discovery, name and `Runtime.evaluate` through the hub (skipped when `bun` is missing).
- Full suite: 209 tests, 208 green, 1 `todo` (defect 1 → M4).
