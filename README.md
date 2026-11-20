# node-outbound-inspector

**English** | [Polski](README.pl.md)

[![test](https://github.com/jakubprill/node-outbound-inspector/actions/workflows/test.yml/badge.svg)](https://github.com/jakubprill/node-outbound-inspector/actions/workflows/test.yml)

Inspect the **outbound HTTP traffic** of Node.js processes, e.g. a Next.js server calling internal services: in Chrome DevTools, and for AI agents through an **MCP** server.

- 🔍 See the server's requests (`fetch`/undici, `node:http`, HTTP/2): URL, headers, status, body, timing.
- 🧩 **Several apps at once** (monorepo): each one is discovered and named automatically.
- 🧭 **Page correlation**: you know which visit to `/checkout` triggered which requests, even when several pages render in parallel.
- 🌊 **Detects sequential requests (waterfalls)**, estimates the gain from `Promise.all`, and reports 4xx/5xx errors.
- 📦 Zero dependencies, **Node ≥ 24** (collector and apps).

> For **local development only**: the Node inspector gives full control over the process.

## How it works

```
 browser ──► Next.js (Node) ──► internal services
                 │  --inspect=<port> --experimental-network-inspection
                 ▼  (Chrome DevTools Protocol: Network.* events)
   ┌─────────────┴─────────────┐
 Chrome DevTools          outbound-mcp  ──► AI agent (Claude Code, Cursor, …)
 ("dedicated DevTools     (MCP, stdio)
  for Node" → Network)
```

Node has an experimental `--experimental-network-inspection` flag (since 22.6 / 20.18; this tool requires Node ≥ 24) that sends network events to an attached DevTools client. `outbound-mcp` attaches as such a client to every process, collects the events and exposes them to the agent as MCP tools.

## Quick start

### 1. Run the app with network inspection
Add the tool as a devDependency (in a monorepo: at the root), e.g. `"node-outbound-inspector": "github:jakubprill/node-outbound-inspector#v0.5.0"`, and in the app:
```jsonc
// app package.json — every app in a monorepo gets its OWN inspector port
"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
```
`outbound-next` resolves `next` the way `require` does from the app directory and runs it via `node --experimental-network-inspection`. All arguments go to `next`; the exit code and signals are passed back to the package manager. It does not depend on a shell, so it works with npm, pnpm, Yarn and Bun on Windows (`cmd.exe`, PowerShell), macOS and Linux. It warns when `--inspect=<port>` is missing or when the inspector would listen outside `127.0.0.1`.
You can point to the CLI file manually with the `OUTBOUND_NEXT_BIN` variable (path relative to the app directory).

<details><summary>Without installing the tool</summary>

The path to the `next` file as a plain `node` argument works in any shell (forward slashes `/` are fine on Windows too):
```jsonc
"dev:inspect": "node --experimental-network-inspection ./node_modules/next/dist/bin/next dev --port 3101 --inspect=9231"
// monorepo where the package manager hoisted next to the root (npm/Bun/Yarn with node_modules):
"dev:inspect": "node --experimental-network-inspection ../../node_modules/next/dist/bin/next dev --port 3101 --inspect=9231"
```
Find where `next` lives once: `node -p "require.resolve('next/dist/bin/next')"` in the app directory. With pnpm, `node_modules/next` in the app is a symlink, so the `./node_modules/…` variant works. Yarn PnP has no `node_modules`, so there is no path to point at. Use `outbound-next` there (Yarn loads PnP via `NODE_OPTIONS` and the child process inherits it; not yet verified on PnP) or `nodeLinker: node-modules`.

The older form `node --experimental-network-inspection $(node -p "require.resolve('next/dist/bin/next')") dev …` needs a POSIX shell (sh, bash, zsh, Git Bash). npm and pnpm on Windows run scripts in `cmd.exe`, where `$(…)` does not work.
</details>

> ⚠️ The flag **does not work** in `NODE_OPTIONS` (Node rejects it). When two apps use the same port (9229 by default), the second one silently runs without an inspector.

If your own script spawns the apps (e.g. started with `bun run`), change the spawn arguments the same way, with a unique inspector port per app. The app must run on the Node runtime, not Bun's (`bun --bun` does not work). Step-by-step instructions for agents: [`llms.txt`](llms.txt).

### 2a. View in Chrome
Run `outbound-hub` next to your apps (e.g. in your dev script). It listens on `127.0.0.1:9229`, which `chrome://inspect` checks by default, finds every app with an inspector on ports 9230–9249 and lists them by name. No ports to add in **Configure…**, new apps show up on their own. Then: `chrome://inspect` → **inspect** next to the app → **Network** tab.

The hub only answers requests whose `Host` is an IP address or `localhost` (DNS rebinding protection, like Node itself) and only forwards DevTools connections to apps it found on the scanned ports. Keep port 9229 free for it: give apps inspector ports from 9230 up. `OUTBOUND_HUB_PORT` changes the port, `INSPECTOR_PORTS` and `APP_NAMES` work as for the MCP server.

Without the hub: **Open dedicated DevTools for Node** → **Connection** → add `localhost:<port>` for every app.

### 2b. Connect an agent (MCP)
```bash
claude mcp add outbound -- node /path/to/node-outbound-inspector/src/outbound-mcp.mjs
```
Or in the MCP client config:
```json
{ "mcpServers": { "outbound": { "command": "node", "args": ["/path/to/node-outbound-inspector/src/outbound-mcp.mjs"] } } }
```

## MCP tools

| Tool | Description |
|---|---|
| `inspector_status` | Connected apps: name, port, pid, directory, page correlation state |
| `list_server_requests` | Requests: app, page, method, URL, status, duration, code location. Returns `{ requests, next_since_id }`; pass `since_id` to page through everything |
| `get_server_request` | Details: full URL, request and response headers, body (paged with `body_offset`), call stack |
| `analyze_server_timeline` | Analysis per app and per page request: SEQUENTIAL / PARALLEL / MIXED, potential saving, errors, duplicates, slow requests. A summary of the newest 20 page requests by default; `page_request_id` or `detail: "full"` for everything; `settle_ms` waits until traffic goes quiet |
| `clear_server_requests` | Clear the buffer (everything or one app) |

Filters: `app`, `page_contains`, `page_request_id`, `url_contains`, `status` (`404`, `5xx`, `error`, `failed`, `pending`), `last_ms`, `since_id`.

Every result fits a hard size limit (20,000 characters by default). A cut result has `truncated: true` and a `truncation_hint` saying how to narrow the call.

A typical agent workflow: `clear_server_requests` → open a page (e.g. with [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)) → `analyze_server_timeline` with `settle_ms` → `analyze_server_timeline` with `page_request_id` or `get_server_request` for details.

The server speaks both MCP eras: the `initialize` handshake (2024-11-05 to 2025-06-18) and the stateless 2026-07-28 revision (`server/discover`, version in `_meta` of every request).

Tool descriptions, tool output and CLI messages are in English. For logic, use the stable codes (`verdict_code`, `body_state`, `error_kind`) rather than the text.

### Configuration (environment variables)
| Variable | Default | Description |
|---|---|---|
| `INSPECTOR_PORTS` | `9230-9249` | Inspector ports/ranges, e.g. `9231,9241`. 9229 (plain `node --inspect`, `outbound-hub`) is left out on purpose |
| `APP_NAMES` | — | Names by port, e.g. `9231=web,9241=admin`. By default the name comes from `npm_package_name`, then from `name` in `package.json` in the process directory, then from the directory name. |
| `PAGE_CORRELATION` | `1` | `0` disables injecting the code that correlates requests with pages |
| `OUTBOUND_REDACT` | `1` | `0` disables secret redaction (warning in `inspector_status`) |
| `OUTBOUND_REDACT_HEADERS` | — | Extra headers to redact, e.g. `x-acme-token,x-tenant-secret` |
| `OUTBOUND_BODIES` | `eager` | Response bodies: `eager` (right away), `lazy` (on `get_server_request`), `off` (never) |
| `OUTBOUND_BODY_MAX_KB` / `OUTBOUND_BODIES_TOTAL_MB` | `256` / `32` | Limit for one response body and for all bodies in the collector |
| `OUTBOUND_INSPECTOR_BUFFER_MB` / `OUTBOUND_INSPECTOR_RESOURCE_MB` | `32` / `2` | Body buffer limits inside the app process (per session) |
| `OUTBOUND_LIBRARY_PATHS` | — | Extra path fragments skipped when finding the call site (`origin`), e.g. your own `fetch` wrapper in the workspace: `packages/http-client/,@acme_tracing_` |
| `IGNORE_HOSTS` | `registry.npmjs.org` | Hosts to skip (Next checks for updates itself) |
| `OUTBOUND_IGNORE_OTLP` | `1` | Skips OpenTelemetry export (e.g. `@vercel/otel` without a local collector): `/v1/traces`, `/v1/metrics`, `/v1/logs` on port `4318` (any host) and OTLP/gRPC (`…Service/Export`). `0` shows this traffic. Skipped rules and counters: `inspector_status` (`ignored_otlp`, `ignored_requests_total`). Add cloud export on another port to `IGNORE_HOSTS`. |
| `MAX_REQUESTS` | `5000` | Buffer size |
| `OUTBOUND_MAX_RESPONSE_CHARS` | `20000` | Hard size limit of one tool result, in characters (minimum 4000) |

## Example and tests

```bash
npm test                         # unit, golden (tool contract), e2e — no Next.js, no network
npm run record                   # record inspector events into test/fixtures/recordings/
npm run golden:update            # refresh golden snapshots (contract change → CHANGELOG entry)
```

Code structure and roadmap: [`docs/architecture.md`](docs/architecture.md), decisions: [`docs/adr/`](docs/adr/) (in Polish).

Example monorepo with two Next.js apps: [`examples/nextjs-monorepo`](examples/nextjs-monorepo/README.md)
```bash
cd examples/nextjs-monorepo && npm install
npm run mock          # fake services on :4001
npm run dev:inspect   # web :3101 (inspector 9231) + admin :3102 (inspector 9241)
npm run demo          # test agent: traffic + analysis
```
The apps' `dev:inspect` scripts are portable (`outbound-next`). The aggregate scripts at the example root (`&`/`wait`, `APPS=…`) need a POSIX shell; on Windows run each app in its own terminal (`npm run dev:inspect -w @acme/web`), details in the example's README.

A minimal CDP client (what the Network tab does): [`examples/cdp-network-probe.mjs`](examples/cdp-network-probe.mjs).

## Together with Next DevTools MCP

Next.js 16 has its own MCP server (`/_next/mcp`, used through `next-devtools-mcp`): routes, errors, compilation, logs, Server Actions and, with `experimental.requestInsights: true`, `get_request_insights` (App Router `fetch` calls with Next cache status). It does not show headers, bodies, `node:http` traffic (axios, SDKs), requests outside a page request, network errors or waterfall analysis. The two servers complement each other; configure both for the agent.

**Does this duplicate Next's MCP? No.** Checked against the Next.js 16.4.6 and 16.5 canary source and `next-devtools-mcp` 0.4.1 (2026-11-20):

| | Next DevTools MCP | node-outbound-inspector |
|---|---|---|
| Server `fetch` list with timing and page request | `get_request_insights` (experimental flag) | ✓ |
| Next cache status (`hit`/`miss`/`hmr`), route pattern, render spans | ✓ | — |
| Errors, compilation, routes, logs, Server Actions | ✓ | — |
| Request and response headers, response bodies | — | ✓ (redacted) |
| `node:http` traffic (axios, SDKs), requests outside a page request | — | ✓ |
| Network errors (refused, reset), time to end of body | — | ✓ |
| Waterfall detection, `Promise.all` saving, duplicates, slow requests | — | ✓ |
| Any Node process, not only Next | — | ✓ |

Full comparison (Polish): [docs/nextjs-mcp-comparison.md](docs/nextjs-mcp-comparison.md).

- Page requests carry `next_request_id` / `next_html_request_id` when the browser sent Next's `x-nextjs-request-id` / `x-nextjs-html-request-id` headers (client navigations, Server Actions in dev). Pass them to `get_request_insights` as `requestId` / `htmlRequestId`, or use them as filters here.
- `inspector_status` lists each app's `http_ports`, the port to pass to `nextjs_call`. `next-devtools-mcp` found both apps of a two-app monorepo started with `outbound-next … --inspect=…` on its own (Next 16.4, macOS); if it misses one, pass the port to `nextjs_index`.
- Requests to Next's own dev endpoints (`/_next/mcp`, HMR, `/__nextjs_*`) are not treated as page requests.
- A request missing here but present in `get_request_insights` with cache status `hit` or `hmr` was served from Next's cache.

## Security model

The Node inspector gives full control over a process, and whatever the tools return goes to your AI model provider. The tool is built for local development only, with these safeguards (security review: [docs/security-audit-2026-11-20.md](docs/security-audit-2026-11-20.md), in Polish):

- **Consent.** The MCP server attaches to every inspector on ports 9230–9249, but injects code, patches and enables network inspection only in processes of the same user that opted in: started with `outbound-next` (sets `OUTBOUND_INSPECT=1`), with `OUTBOUND_INSPECT=1`, or with `--experimental-network-inspection`. Other processes show up in `inspector_status` with `skipped: "no_consent"` or `"other_user"`. Port 9229 (plain `node --inspect`) is not scanned by default.
- **Loopback only.** Targets are accepted only when their WebSocket address points to the scanned port on 127.0.0.1/localhost. `outbound-next` refuses an inspector on another address (`--inspect=0.0.0.0`, `--inspect-port`, `NODE_OPTIONS`) unless `OUTBOUND_ALLOW_REMOTE_INSPECT=1`. In Docker publish the port as `-p 127.0.0.1:<port>:<port>`. `outbound-hub` listens on 127.0.0.1, checks the `Host` header (DNS rebinding) and forwards only to apps it found.
- **Hostile local processes.** Anything on a scanned port can pretend to be an inspector. Malformed data is dropped, sizes are capped (targets, sessions, URLs, headers), and `package.json` is read only as a regular file.
- **Redaction before storage** (best effort): headers by name; URLs inside headers (`Location`, `Link`); URL query and fragment parameters by name, passwords in URLs; the page request URL; JSON bodies as a tree (objects and arrays under secret-like keys too) and truncated JSON; form-urlencoded bodies; known token formats anywhere (JWT, GitHub, Stripe, Slack, AWS, Google API keys, Telegram bot tokens, Slack/Discord webhooks, PEM private keys). Redaction runs before bodies are cut. **Not covered:** personal data under neutral names, secrets in unusual formats, request bodies are not stored at all. Use `OUTBOUND_BODIES=off` for sensitive integrations, or `INSPECTOR_PORTS` with exact ports.
- **Untrusted data.** Tool descriptions and server instructions tell the model that every value comes from inspected processes and services and is not an instruction. App names are reduced to `[\w@./+:-]`, control characters are stripped from texts.
- **What leaves the machine:** URLs, headers, response bodies (after redaction), error texts, stack paths and the process directory of inspected apps.

## Limitations
- The Node feature is **experimental**. Node ≥ 24 is required (tested in CI on 24 and the latest version). On older Node the collector does not start, and an app process is not inspected (the reason is in `inspector_status`).
- **Bun** as a runtime is not supported (WebKit Inspector instead of CDP). It works if Bun only installs packages and runs scripts while the app runs on Node.
- In Next.js, `fetch` is wrapped by Next itself, so the call stack does not show the page's line. Find the code by URL and the correlated page.
- Requests outside a page request (server start, background jobs) go into the "no page" group.
- The Edge runtime is not covered.
- `outbound-mcp` injects code into the process (`diagnostics_channel` and `AsyncLocalStorage`). Use it only locally, with the inspector on `127.0.0.1`.
- Bodies with `content-encoding` (gzip, br, deflate, zstd) are decompressed (`body_encoding`, `body_encoded_bytes`). When `content-type` has a `charset`, the Node inspector returns the compressed bytes as garbled text and the body is marked `unavailable`.
- **Node bug [#66551](https://github.com/nodejs/node/issues/66551):** when an app reads a `node:http` response after `res.setEncoding()` (many libraries do) while a client with network inspection is attached, Node throws `Missing dataLength in event` and destroys the connection. The app then gets an error or no response at all. `outbound-mcp` installs a workaround in the app process before enabling inspection (`node_workarounds` in `inspector_status`). **Chrome DevTools alone (without the collector) still triggers this bug.**
- Node inspector behavior the tool cannot change: when a `node:http` connection drops while the body is being received, the request stays in flight (no final event).
- Redaction is best effort; see [Security model](#security-model).

## Documentation
- [`llms.txt`](llms.txt): integration and usage guide for AI agents
- The documents below are in Polish:
  - [Full analysis: the problem, alternatives (proxy, OpenTelemetry/Jaeger), WebMCP, recommendations](docs/analysis.md)
  - [Test results](docs/test-results.md)
  - [Changelog](CHANGELOG.md)

## License
[MIT](LICENSE) © 2026 Jakub Prill
