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
Add the tool as a devDependency (in a monorepo: at the root), e.g. `"node-outbound-inspector": "github:jakubprill/node-outbound-inspector#<tag>"`, and in the app:
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
`chrome://inspect` → **Open dedicated DevTools for Node** → **Network** tab.

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
| `list_server_requests` | Requests: app, page, method, URL, status, duration, code location |
| `get_server_request` | Details: request and response headers, body, call stack |
| `analyze_server_timeline` | Analysis per app and per page request: SEQUENTIAL / PARALLEL / MIXED, potential saving, errors |
| `clear_server_requests` | Clear the buffer (everything or one app) |

Filters: `app`, `page_contains`, `url_contains`, `last_ms`, `since_id`.

A typical agent workflow: `clear_server_requests` → open a page (e.g. with [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)) → `analyze_server_timeline` → `get_server_request` for errors.

Tool descriptions and tool output are currently in Polish.

### Configuration (environment variables)
| Variable | Default | Description |
|---|---|---|
| `INSPECTOR_PORTS` | `9229-9249` | Inspector ports/ranges, e.g. `9231,9241` |
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
- Secrets in headers and URL parameters are redacted before they reach the agent. Response bodies are not redacted (yet), so use `OUTBOUND_BODIES=off` for sensitive integrations.

## Documentation
- [`llms.txt`](llms.txt): integration and usage guide for AI agents
- The documents below are in Polish:
  - [Full analysis: the problem, alternatives (proxy, OpenTelemetry/Jaeger), WebMCP, recommendations](docs/analysis.md)
  - [Test results](docs/test-results.md)
  - [Changelog](CHANGELOG.md)

## License
[MIT](LICENSE) © 2026 Jakub Prill
