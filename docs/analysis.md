# Next.js: server-side network traffic inspection (Chrome DevTools + MCP for agents)

_Analysis and test results · as of 2026-11-19 (historical: written for the prototype; current usage is in the README)_

## Contents
1. [Problem](#1-problem)
2. [Base solution: network inspection in Node](#2-base-solution-network-inspection-in-node)
3. [Test results](#3-test-results)
4. [Pitfalls](#4-pitfalls)
5. [Monorepo: several apps at once](#5-monorepo-several-apps-at-once)
6. [AI agent: the `outbound-mcp` MCP server](#6-ai-agent-the-outbound-mcp-mcp-server)
7. [WebMCP and Chrome DevTools MCP: what fits and what does not](#7-webmcp-and-chrome-devtools-mcp-what-fits-and-what-does-not)
8. [Alternatives](#8-alternatives)
9. [Recommendation and rollout steps](#9-recommendation-and-rollout-steps)
10. [Limitations and security](#10-limitations-and-security)

---

## 1. Problem
In a Next.js app most calls to integrations are made by the server (Node), not the browser. That is why they do not show up in the **Network** tab in Chrome DevTools. The goal is to view this traffic in development mode (URL, headers, status, body, timings) and to analyze it automatically: errors, sequential and parallel requests.

## 2. Base solution: network inspection in Node
Node has a built-in, experimental `--experimental-network-inspection` flag that emits Chrome DevTools Protocol (CDP) `Network.*` events for `fetch` (undici), `node:http`/`https` and HTTP/2.

```json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --inspect"
```

The `$(…)` syntax needs a POSIX shell; on Windows (`cmd.exe`) use `outbound-next dev --inspect` or the path `./node_modules/next/dist/bin/next` (README, "Quick start").

Usage:
1. `npm run dev:inspect`
2. Chrome → `chrome://inspect` → **Open dedicated DevTools for Node** → **Network** tab
3. Open the app. Server calls appear in that separate DevTools window.

## 3. Test results
Environment: MacBook (Apple Silicon), Next.js 16.4.0, tests run on 2026-11-18/19.

| Environment | `fetch` (undici) | `node:http` (axios/got) |
|---|---|---|
| Node 26.12 + Next 16.4 **Turbopack** | ✅ URL, headers, status, body | ✅ complete |
| Node 26.12 + Next 16.4 webpack | ✅ complete | ✅ complete |
| Node 22.23 (no Next) | ⚠️ no response body | ✅ complete |
| Bun 1.4 as the runtime | ❌ (WebKit Inspector, not CDP) | ❌ |

- In dev mode Next 16 runs in **one process** with the inspector, so one connection is enough.
- A Chrome DevTools window and an agent (MCP) can be attached **at the same time**, and both see the same events.

## 4. Pitfalls
- ❌ `NODE_OPTIONS='--experimental-network-inspection'` **does not work**: Node rejects this flag in `NODE_OPTIONS`. It must be passed to `node` directly.
- `--inspect` is passed as an argument of `next dev`.
- **Node ≥ 24** is required. On Node 22 the `fetch` response body is missing.
- The feature is experimental and may change between Node versions.
- Server traffic is in a **separate** DevTools window, not together with page traffic.
- Next itself polls `registry.npmjs.org` (update check). Just filter it out.
- Bun as the runtime (`bun --bun next dev`) is not supported. `BUN_CONFIG_VERBOSE_FETCH=curl` remains. If Bun is used only to install packages and run scripts while Next runs on Node, everything works.
- Docker: inside the container `--inspect=0.0.0.0:<port>` (with `outbound-next` this needs `OUTBOUND_ALLOW_REMOTE_INSPECT=1`), and the port published **only on the host loopback**: `-p 127.0.0.1:<port>:<port>`. A plain `-p <port>:<port>` exposes the inspector, i.e. code execution in the process, to anyone on the network. Edge runtime is not covered.

## 5. Monorepo: several apps at once
**Problem:** with a parallel `dev` (turbo / workspaces) all apps try to take port 9229.

| Scenario | Result |
|---|---|
| A: every app with a bare `--inspect` | ❌ The first takes 9229. The second only prints `Starting inspector on 127.0.0.1:9229 failed: address already in use` and **keeps running without an inspector**. Next shows "Debugger port" only for the first, so it is easy to miss. Both apps use the same `next` from `node_modules`, so they look identical in the inspector. |
| B: a separate port per app | ✅ Both visible, and one MCP server tells them apart correctly. |

**Configuration (every app has its own inspector port):**
```jsonc
// apps/web/package.json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --port 3101 --inspect=9231"
// apps/admin/package.json
"dev:inspect": "node --experimental-network-inspection $(node -p \"require.resolve('next/dist/bin/next')\") dev --port 3102 --inspect=9241"
// package.json (root) — in parallel, like `dev`
"dev:inspect": "npm run dev:inspect -w @acme/web & npm run dev:inspect -w @acme/admin & wait"
```
`require.resolve` finds `next` wherever the package manager put it (hoisted or pnpm). The `$(...)` syntax does not work in Windows cmd. The portable, shell-independent form: `"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"` (README, "Quick start"; issue #5).

**Test result (2 × Next 16.4 Turbopack started in parallel, traffic generated in both at once):**

| App | Page | Requests | Time | Verdict |
|---|---|---|---|---|
| `@acme/web` | `GET /seq` | 3 | 469 ms | SEQUENTIAL, possible saving 313 ms |
| `@acme/web` | `GET /err` | 1 | 89 ms | 500 error from `/payments` |
| `@acme/admin` | `GET /par` | 3 | 163 ms | PARALLEL |
| `@acme/admin` | `GET /seq` | 2 | 320 ms | SEQUENTIAL, possible saving 161 ms |

The same URL (`/user`) called by both apps at the same moment was assigned correctly to each of them.

## 6. AI agent: the `outbound-mcp` MCP server
A prototype MCP server (a single file `src/outbound-mcp.mjs`, no dependencies, Node ≥ 22). It attaches to Node inspectors and gives the agent (Claude Code, Cursor, Copilot…) access to server traffic together with analysis.

**Tools:**
| Tool | Description |
|---|---|
| `inspector_status` | Attached apps: name, port, pid, directory |
| `list_server_requests` | Requests: app, page, method, URL, status, time |
| `get_server_request` | Request and response headers, body, call stack |
| `analyze_server_timeline` | Per app and per page request: detects sequential and parallel requests, computes the `Promise.all` gain and collects errors |
| `clear_server_requests` | Clears the buffer (all or one app) |

**How it works:**
- Scans inspector ports (`9229-9249` by default) and attaches to every process.
- **Recognizes the app:** reads the working directory and package name from the process, plus `name` from `package.json`. `APP_NAMES` can override this.
- **Assigns a request to a page:** injects a small listener into the process (`diagnostics_channel` and `AsyncLocalStorage`) that remembers which incoming page request caused a given request. Parallel rendering of several pages therefore does not mix. Nothing has to change in the app code.

**Connecting:**
```bash
claude mcp add outbound -- node /path/node-outbound-inspector/src/outbound-mcp.mjs
# optionally: -e INSPECTOR_PORTS=9231,9241 -e APP_NAMES=9231=web,9241=admin
```

**Recommended agent workflow:** `clear_server_requests` → open the page (e.g. through Chrome DevTools MCP) → `analyze_server_timeline` → `get_server_request` for errors.

## 7. WebMCP and Chrome DevTools MCP: what fits and what does not
- **WebMCP** (`document.modelContext`, formerly `navigator.modelContext`) serves another purpose: through it a page exposes **its own actions** to an agent in the browser. It gives no access to server traffic. For now it is available only in Chrome, as an origin trial. **Not suitable for this goal.**
- **Chrome DevTools MCP** (official, Google) handles the page in the browser: navigation, Network, console and performance. It does not attach to a Node process. **A good complement to `outbound-mcp`:** together they give the agent the full picture of one request, from browser to server.

## 8. Alternatives
- **An intercepting proxy** (HTTP Toolkit, mitmproxy, Proxyman): one view of browser and server traffic, runtime-independent. Needs undici redirected (`setGlobalDispatcher(new ProxyAgent(...))`) as well as `http`/`https`. For HTTPS add `NODE_EXTRA_CA_CERTS`.
- **`node-network-devtools`** (npm): a view in Chrome DevTools through `register()` in `instrumentation.ts`. Does not support Bun.
- **OpenTelemetry + Jaeger**: a different goal. Shows timings and flow between services and works on staging and production. Next has built-in support (`instrumentation.ts`, `@vercel/otel`). No request and response bodies by default. **It complements network inspection, it does not replace it.**

## 9. Recommendation and rollout steps
1. **Now:** add `dev:inspect` with a separate inspector port for every app in the monorepo. Use Node ≥ 24.
2. **For agents:** `outbound-mcp` together with Chrome DevTools MCP. A pilot on one real page of the monorepo.
3. **To do in the prototype:** resolving source maps (`.map` in `.next/dev`), to point at source files instead of compiled chunks.
4. **Later, if visibility across services and environments is needed:** OpenTelemetry with Jaeger (locally the `jaegertracing/all-in-one` container).

## 10. Limitations and security
- In Next.js `fetch` is wrapped by Next itself (`dedupeFetch`), so the call stack ends inside it. **The page code line is not visible.** The code is found by the request URL and the assigned page. Outside Next (plain Node) the exact line is visible.
- Requests made outside a page request context (server start, background jobs) go to the "no page" group.
- The inspector gives **full control over the process**, and `outbound-mcp` injects code into it. This is a tool **for local development only**. The inspector should stay on the default address `127.0.0.1` and must never reach a shared environment.
