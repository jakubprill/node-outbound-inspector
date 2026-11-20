<!-- Report of 2026-11-20, prepared when comparing with Next DevTools MCP. Knowledge as of that day; re-check with new Next versions. -->

> **Verified on real Next 16.4.0 (macOS, Node 26.12, two-app monorepo, 2026-11-20).** Hypotheses from this report:
> - discovery by `next-devtools-mcp` with `--inspect`: **no collision**, `nextjs_index` without a port found both apps (3101 and 3102);
> - the `x-nextjs-request-id` / `x-nextjs-html-request-id` headers: `get_request_insights({ requestId })` returned the same request (`route: /seq`, matching `htmlRequestId`) as our `next_request_id`, so the join works;
> - `/_next/mcp` requests did not show up as page requests.
# node-outbound-inspector and the Next.js MCP: comparison

_As of 2026-11-20. Versions checked: Next.js **v16.4.6** (latest stable tag, 2026-11-09), the `canary` branch (**v16.5.0-canary.57**, commit of 2026-11-19), `next-devtools-mcp` **0.4.1** (repository HEAD of 2026-09-14). Our tool: 0.5.0._

**Markers:**

| Marker | Meaning |
|---|---|
| **[D]** | fact from nextjs.org docs or blog, or from the `next-devtools-mcp` README |
| **[K]** | fact from source code (`vercel/next.js` v16.4.6 or canary, `vercel/next-devtools-mcp` 0.4.1) |
| **[W]** | the report author's conclusion |
| **[H]** | hypothesis to check on a real monorepo |

**Limits of this analysis.** I did not run Next.js. The npm registry was not reachable, so I determined versions from git tags and `package.json` in the repositories, not from `npm view`. I read the code directly from the repositories.

---

## TL;DR

- The Next.js MCP **has** one tool that touches the server's outbound requests: `get_request_insights` (since 16.3, needs `experimental.requestInsights`). For every `fetch` made in an App Router request context it gives the URL, method, status, start time and duration, **Next cache status** and the link to the page request (`requestId`, `htmlRequestId`, `route`) **[K]**.
- It has no headers, bodies, `node:http` (axios, got, SOAP, SDK clients), requests outside a request context, waterfall analysis, `Promise.all` savings, duplicates or slow requests. Nor a response size limit (in 16.4.6) **[K]**.
- **Our tool does not duplicate the Next MCP** **[W]**. It overlaps in the "list of `fetch` calls with timings and page assignment" part. Otherwise the tools complement each other: Next sees the framework (routes, cache, errors, compilation, render spans), we see the network (headers, bodies, `node:http`, timeline analysis).
- The cheapest integration: the hook reads the `x-nextjs-request-id` and `x-nextjs-html-request-id` headers, which the browser sends in dev with RSC navigations and Server Actions, and stores them with the page request. The agent then joins our results with `get_request_insights({ requestId | htmlRequestId })` exactly, without matching by time **[K → W]**.
- Risk in a monorepo: `next-devtools-mcp` on its own finds only servers on ports 3000–3010 or a `next-server` process, taking the **first** port the process listens on. Our `--inspect=<port>` adds a second port in the same process **[K]**, so discovery may hit the inspector port **[H]**. Workaround: app ports from 3000–3010 or an explicit `port` in `nextjs_index` and `nextjs_call`.

---

## 1. What the Next.js MCP provides

### 1.1. Two layers

1. **The `/_next/mcp` endpoint** built into `next dev` (Next ≥ 16), on by default; `experimental.mcpServer: false` turns it off **[D]**. Transport: Streamable HTTP, stateless (`sessionIdGenerator: undefined`), with a 1 MB request body limit **[K]**. Runs in the app server process.
2. **The `next-devtools-mcp` package** (stdio) is a "thin bridge": it discovers running dev servers and forwards calls to their `/_next/mcp` **[D]**. Skills such as `next-dev-loop` call `/_next/mcp` directly, without this package **[D]**.

### 1.2. `next-devtools-mcp` 0.4.1 tools [D, K]

| Tool | What it does |
|---|---|
| `nextjs_index` | Discovers dev servers and lists their tools (port, PID, URL, schemas). Optional `port` when discovery fails. |
| `nextjs_call` | Calls a tool on a server: `port`, `toolName`, `args`. JSON result with `success`. 60 s timeout. |
| `nextjs_docs` | A gate: points to the docs shipped with the package (`node_modules/next/dist/docs/`), downloads nothing. |
| `browser_eval` | A gate: points to the `agent-browser` CLI, does not drive a browser itself. |

Since 0.4.0 these are **removed**: `init`, `upgrade_nextjs_16`, `enable_cache_components`, prompts and resources `cache-components://`, `nextjs16://`, `nextjs-fundamentals://`. Upgrade and Cache Components are now skills (`next-cache-components-adoption` and others) **[D]**.

### 1.3. `/_next/mcp` endpoint tools (v16.4.6)

| Tool | Returns | Since [K] |
|---|---|---|
| `get_errors` | Errors: `next.config`, browser runtime, build errors with source-mapped stacks. Needs an open page. | 16.0 |
| `get_logs` | **Only the path** to `{distDir}/logs/next-development.log` (browser console and server output); the agent reads the file itself. | 16.0 |
| `get_page_metadata` | Metadata of what makes up the current page render. Needs an open page. | 16.0 |
| `get_project_metadata` | Project path and dev server URL. | 16.0 |
| `get_server_action_by_id` | Server Action ID → source file and export name. | 16.0 |
| `get_routes` | File-system routes (`appRouter`, `pagesRouter`), dynamic segments as patterns. | 16.1 |
| `get_compilation_issues` | Compilation errors of the whole module graph. **Turbopack only.** | 16.3 |
| `compile_route` | Compiles one route without an HTTP request. **Turbopack only.** | 16.3 |
| `get_request_insights` | App Router request timelines, server `fetch`, cache behavior. **Needs `experimental.requestInsights`.** | 16.3 |

Sources: [D] the list and descriptions in the MCP docs; [K] the `packages/next/src/server/mcp/tools/` directory in tags v16.0.0 … v16.4.6. `canary` has no new tools; only `get_request_insights` changes (section 2.2) **[K]**.

There are **no** tools for: `fetch` logs as data, OpenTelemetry/trace export, request headers or bodies, `node:http`, Edge **[K]**.

---

## 2. Does Next show the server's outbound requests

### 2.1. `get_request_insights` in v16.4.6: details from the code [K]

- **Data source:** a local span recorder (`lib/trace/local-span-recorder.ts`, `request-insights.ts`) works without an OTEL collector. `experimental.requestInsights: true` enables it, in `next dev` only (variables `__NEXT_DEV_SERVER` and `__NEXT_REQUEST_INSIGHTS`). A comment in `config-shared.ts` says the flag also shows Request Insights in Next DevTools (the dev indicator). In the v16.4.6 docs the flag appears only in `guides/mcp` **[D]**.
- **What counts as a request:** only a `fetch` wrapped by Next (`patch-fetch.ts`), i.e. the `AppRender.fetch` span or the `trackFetchMetric` metric. The metric exists only when there is a `workStore` (render, Route Handler, Server Action) and the request is not internal. A `fetch` without a `workStore` goes straight to the original, without a metric. **No `node:http` at all.**
- **`fetches[]` fields:** `url` (without credentials, parameters with secret-like names replaced with `redacted`), `method`, `statusCode`, `startTime`, `durationMs`, `cacheStatus` (`hit`, `miss`, `skip`, `hmr`), `cacheReason`, `index`. **No headers or bodies.** Span attributes are filtered to an allowlist (`http.*`, `net.peer.*`, `next.*`).
- **Timing:** `durationMs` is measured from the start until `originFetch` resolves (`.then`), i.e. **until the response headers**, not the end of the body.
- **Errors:** a rejected `fetch` (network error) does not reach the metric. It may appear only as a span with status `error`, which is a conclusion from the code, unchecked **[H]**. 4xx and 5xx codes are in `statusCode`.
- **Page assignment:** `requestId`, `htmlRequestId` (links RSC requests and Server Actions to the HTML document), `route` (route pattern), `url`, `kind`, `status`. Spans have `traceId`, `spanId` and `parentSpanId`. With OTel active, `traceId` comes from a real OTel span; without it, it is a local counter (`tracer.ts`, `local-span-recorder.ts`).
- **Ids:** the server takes `requestId` from the `x-nextjs-request-id` header and generates one (`nanoid`) when it is missing. `htmlRequestId` comes from `x-nextjs-html-request-id` (`base-server.ts`). In dev the browser sends both headers with RSC navigations and Server Actions, and the HTML document embeds `self.__next_r` with the HTML request id (`fetch-server-response.ts`, `server-action-reducer.ts`, `app-render.tsx`).
- **Retention and size:** the last 100 requests are kept in memory. The result is `JSON.stringify(…, null, 2)` of all matching requests with **all spans**, without a size limit or paging. Filters: only `requestId` and `htmlRequestId`.
- **Analysis:** none. No sequential/parallel verdict, savings estimate, duplicates or slow requests. The agent infers from `startTime` and `durationMs` itself.

### 2.2. `get_request_insights` on canary (16.5, not released yet) [K]

- Without filters it returns a **summary of the last 20 requests** (`spanCount`, `fetchCount`, `statusCode`, `hasError`, `cacheStatuses`, `isRsc`, `hasProxyActivity`) with a hint "pass `requestId`".
- With `requestId` or `htmlRequestId` it also reads a **history log**, i.e. requests that fell out of the in-memory window. For `htmlRequestId` the limits are 100 requests and 1 MB.
- New fields `source` (page, api, image, asset) and `proxyStatus`.
- The `RequestInsightFetch` shape **does not change**: still no headers, bodies or `node:http`.
- **[W]** Next is heading toward "smaller result, details on request", i.e. the same contract as our ADR 0008. It is not heading toward network data.

### 2.3. Other sources in Next

| Mechanism | What it gives | For the agent |
|---|---|---|
| `logging.fetches` in `next.config` | A terminal line for every `fetch`: method, URL (full with `fullUrl: true`), status, time, cache status and reason **[D, K: `log-requests.ts`]** | Terminal text. Does it reach `next-development.log` (`get_logs`)? The file is fed by `handleLog` from console entries **[K]**, while `fetch` lines go a separate way (`writeLine`), so probably not **[H]**. |
| Request Insights in Next DevTools | A panel in the dev overlay (comment in `config-shared.ts`) **[K]** | For people. The same data as `get_request_insights`. |
| `.next/trace` | Build spans and `handle-request` with the incoming request URL (`next-dev-server.ts`) **[K]** | No outbound `fetch`. |
| OpenTelemetry (`@vercel/otel`) | `AppRender.fetch` spans with `http.url`, `http.method`, `http.status_code`, `net.peer.*` **[K]** | Needs a collector (e.g. Jaeger). No bodies or headers; `node:http` only with extra instrumentation. |
| `get_page_metadata`, segment explorer | Page render structure **[D]** | Nothing about the network. |

**Answer to question 2:** only `get_request_insights` (and the same mechanism in the DevTools panel) shows outbound `fetch` calls with timings, order (via `startTime` and `index`) and page request assignment. No Next mechanism shows headers, bodies or `node:http` **[K]**.

---

## 3. Monorepo and several apps at once

- **Endpoint:** every `next dev` instance has its own `/_next/mcp` on its own HTTP port **[D]**.
- **Discovery in `next-devtools-mcp`** (`nextjs-runtime-manager.ts`) **[K]**:
  1. a `POST /_next/mcp` probe (`tools/list`) on ports **3000–3010** (http, then https), host `localhost` or `NEXT_DEVTOOLS_HOST`;
  2. processes named `next-server` (macOS, Linux; on Windows a `node` command line) and the **first** listening port of the process from `pid-port`, with `ss` or `netstat` as a fallback; then a probe to verify.
  3. The `nextjs_index` result is port, PID and URL, **without the app name**. The name and directory must be taken from each instance's `get_project_metadata`.
- **Risk with our `--inspect`** **[H]**: `next dev --inspect=<port>` starts the inspector in the same server process. The process then listens on two ports (HTTP and inspector), and step 2 takes the first one in undefined order. If it is the inspector port, the probe fails and the app disappears from `nextjs_index`. Our example (`3101`, `3102`) is outside the step 1 range, so it depends on step 2 only. To check on a real monorepo. Workarounds: app ports from 3000–3010, `nextjs_index({ port })` and `nextjs_call({ port })` with an explicit port, ports written into `AGENTS.md`/`CLAUDE.md`.
- **Our tool:** scanning 9229–9249 or `INSPECTOR_PORTS`, names from `package.json` or `APP_NAMES`, one collector for all apps, an `app` filter **[README]**.

---

## 4. Requirements and limitations

| | Next.js MCP | node-outbound-inspector |
|---|---|---|
| Framework version | Next ≥ 16 for the endpoint; `get_routes` since 16.1; compilation and `get_request_insights` since 16.3 **[K]** | Next 16.1+ (`next dev --inspect`), checked on 16.4 |
| Node | `next-devtools-mcp`: Node ≥ 20.19 **[D]**; the app as Next requires | ≥ 24 for the collector and the app |
| Bundler | `get_compilation_issues` and `compile_route` **Turbopack only** **[D]**; the rest independent | independent (Turbopack source maps planned in M5) |
| Configuration | none for the basics; `experimental.requestInsights: true` for `fetch` **[D]** | Node flag on the command line and a unique `--inspect` per app (`outbound-next`) |
| Mode | `next dev` only **[D, K]** | local dev only |
| Edge runtime | no information in the sources (not checked) | not supported |
| Bun | `bun dev` in the docs as a way to start **[D]**; Bun runtime (`--bun`) not checked | Bun as package manager and `bun run`: yes; Bun runtime: no |
| Open pages | `get_errors` and `get_page_metadata` need an open page in a browser **[D]** | traffic is visible regardless of the browser (e.g. `curl`) |
| Telemetry | `next-devtools-mcp` sends anonymous telemetry, `NEXT_TELEMETRY_DISABLED=1` turns it off **[D]**; Next counts MCP tool calls **[K]** | none |
| Data security | URLs cleaned of secrets, allowlisted attributes, no bodies **[K]** | redaction of headers, URLs and JSON fields; bodies go to the model (modes `eager`, `lazy`, `off`) |

---

## 5. Comparison table

Rating: **overlaps** = both give the same; **complements** = one sees what the other lacks, worth using both; **missing here** / **missing in Next**.

| Feature | Next.js MCP | node-outbound-inspector | Rating |
|---|---|---|---|
| Server `fetch` list with URL, method, status, time | `get_request_insights` (needs a flag) | `list_server_requests` | **overlaps** |
| `fetch` assigned to the page request | `requestId`, `htmlRequestId`, `route` (pattern) | `page`, `page_request_id` (request URL) | **overlaps**; Next has the route pattern and the RSC-to-document link, we do not |
| `node:http` (axios, got, SDK, SOAP) | none | yes | **missing in Next** |
| `fetch` outside a request context (startup, background jobs, `fetch` without `workStore`) | none (not recorded without `requestId`) | yes ("no page" group) | **missing in Next** |
| Request and response headers | none | yes, redacted | **missing in Next** |
| Response body (and request body when available) | none | yes, paged | **missing in Next** |
| Time to end of body, TTFB | only until headers | both | **missing in Next** |
| Network errors (connection reset, refused) | uncertain (at most an `error` span) | `failed` with `error_kind` | **missing in Next** (partly) |
| Waterfall detection, `Promise.all` savings, data dependencies | none | `analyze_server_timeline` | **missing in Next** |
| Duplicates, slow requests, in flight | none | `findings` | **missing in Next** |
| `fetch` cache status (`hit`, `miss`, `skip`, `hmr`) and reason | yes | none (a cache hit = no request) | **missing here** → complements |
| Render spans (render, segments, proxy) | yes | none | **missing here** → complements (out of scope) |
| Compilation and runtime errors | `get_errors`, `get_compilation_issues`, `compile_route` | none | **missing here** → complements (out of scope) |
| Routes, page metadata, project | `get_routes`, `get_page_metadata`, `get_project_metadata` | none | **missing here** → complements (out of scope) |
| Server Action → file | `get_server_action_by_id` | none (M7 plans only the action ID) | **complements** |
| Server and browser logs | `get_logs` (file path) | none | **complements** |
| Docs, upgrade, Cache Components | `nextjs_docs`, skills | none | out of scope |
| Call site (file:line) of the `fetch` | none | `origin` (limited in Next; M5) | **missing in Next** |
| Several apps at once | yes, per port; no names; ports 3000–3010 or process discovery | yes, names from `package.json`, one collector | **overlaps**; more convenient here in a monorepo |
| Filters and paging | `requestId`, `htmlRequestId`; canary: a summary of 20 | `app`, `page_contains`, `url_contains`, `status`, `last_ms`, `since_id`, … | **missing in Next** |
| Result size limit | 16.4.6: none; canary: summary and 1 MB | hard limit of 20,000 characters with `truncation_hint` | **missing in Next** (16.4) |
| Non-Next (any Node process) | no | yes | **missing in Next** |
| No changes to how the app starts | yes (a flag in `next.config`) | no (Node flag, inspector port) | **missing here** |
| Edge runtime | unknown | no | — |

---

## 6. Conclusions and recommendations

### 6.1. Do we duplicate the Next MCP? [W]

No. The shared part is the skeleton: a list of `fetch` calls with timing and page. Our tool's value lies outside it: headers, bodies, `node:http`, traffic outside a request, network errors, timeline analysis and a result limit. Next, in turn, has what we will never see by design: cache (`hit`, `hmr`), route pattern, render spans, errors and compilation. Risk 9 in `architecture.md` ("Next will provide the same itself") is **low for network data** today. The canary code develops Request Insights toward ergonomics (summaries, history), not headers and bodies. Worth re-checking with every minor release.

**When the Next MCP alone is enough:** the team uses only `fetch` in the App Router, and the question is "how many requests and do they hit the cache". Then `get_request_insights` needs no changes to how apps start and gives data without an inspector.

### 6.2. How to use both together (agent workflow) [W]

One agent, two MCP servers (`.mcp.json`: `next-devtools` and `outbound`), plus a browser (`agent-browser` via the `next-dev-loop` skill, or Chrome DevTools MCP). In each app's `next.config` (dev only): `experimental.requestInsights: true`.

1. `outbound.inspector_status` → apps and ports. `next-devtools.nextjs_index` (with `port` if discovery fails).
2. `outbound.clear_server_requests` → open the page in the browser.
3. `outbound.analyze_server_timeline({ settle_ms: 500 })` → waterfall, errors, slow requests, `page_request_id`.
4. `next-devtools.nextjs_call(port, "get_request_insights", { requestId | htmlRequestId })` → route pattern, cache status of every `fetch`, render spans. Explains why something is **missing** from our traffic (`hit` or `hmr`).
5. `outbound.get_server_request(id)` for errors (the service's response body); `nextjs_call(port, "get_errors")` for render errors; `get_server_action_by_id` for actions.
6. After a code fix: `compile_route`, then repeat steps 2–3 and compare `wall_ms`.

### 6.3. What to add or change

| # | Change | Reason | Cost |
|---|---|---|---|
| 1 | **The hook reads `x-nextjs-request-id`, `x-nextjs-html-request-id` and `traceparent` on the page request.** `next_request_id` and `next_html_request_id` fields in results, filters with the same names. | Exact join with `get_request_insights` for RSC navigations and Server Actions **[K]**. Grouping all requests of one page view (document + RSC + actions) also without the Next MCP. Read-only. | S (M7 scope, can be earlier) |
| 2 | Optionally (opt-in): for an HTML document without the header, the hook sets `x-nextjs-request-id` to our `page_request_id` before Next handles it. | Next takes the ID from the header **[K]**, so the join would be exact for the first visit too. Needs a check that `http.server.request.start` precedes reading the header in the Next server process **[H]**. Changes the request, so opt-in only. | S |
| 3 | `inspector_status`: the app's HTTP port (e.g. `req.socket.localPort` from the hook) and the dev server URL. | The agent passes the port to `nextjs_call` without guessing, which avoids the discovery problem from section 3. | S |
| 4 | `llms.txt` and README: a "together with Next DevTools MCP" section (the 6.2 workflow, `requestInsights`, ports 3000–3010 or explicit ports, reading a missing request as a possible cache hit). | The agent does not guess the division of roles. | S |
| 5 | `architecture.md`: close S5 and open question 5 with the result of this analysis; update section 6.4 ("`get_request_insights` sees only `fetch` in a request context, without headers and bodies") and risk 9. | The document relies today on an assumption made before checking. | S |
| 6 | Check **[H]** whether `POST /_next/mcp` requests (from `next-devtools-mcp`) and `/_next/webpack-hmr` show up as page requests in `analyze_server_timeline`; if so, skip them by default. | Noise in the summary. | S |

**What to drop or not build** **[W]**:

- Add nothing about routing, errors, compilation or Next cache. The Next MCP does that, and we have no access to that data without depending on framework internals.
- Keep the M7 "action id" plan as a field. Mapping ID → file is done by `get_server_action_by_id`.
- Do not build our own cache or render-span panel. If the team wants one view, an agent combining both sources is the better way.
- Consider whether M5 (call site via a Proxy on `fetch`) is still worth the risk. Next gives `index` and `route`, and an agent with the URL and route usually finds the code. M5 stays valuable for `node:http` and for code outside `page.tsx` (helpers, workspace packages); a decision to make after S3.

### 6.4. Can we integrate with the Next MCP? [W]

| Way | Feasibility | Notes |
|---|---|---|
| Correlation by `x-nextjs-request-id` / `x-nextjs-html-request-id` | **high** | The browser sends the headers in dev **[K]**; see 6.3 item 1. |
| Correlation through `self.__next_r` | high (via the agent) | The agent reads `self.__next_r` in the browser (`evaluate_script`, `agent-browser`) and filters both tools by `htmlRequestId`. |
| Correlation by URL and time | medium | `startTime` in Next is `performance.timeOrigin + performance.now()` (epoch ms) **[K]**, ours is `wallTime`. Same clock, but Next's `durationMs` ends at the headers. A good fallback. |
| Correlation by `traceId` | low | Without OTel, Next's `traceId` is a local counter **[K]**. Whether it reaches outbound requests as `traceparent` (with and without OTel) was not checked **[H]**; without that there is nothing to join on. Useful only in teams that already use `@vercel/otel`. |
| Our collector calls `/_next/mcp` (e.g. `get_request_insights`) and enriches results with `route` and `cacheStatus` | possible, but **not recommended now** | Depends on an experimental, changing shape (16.4 and canary differ) and on a flag. The agent joins the data more cheaply. Revisit when Request Insights stops being experimental. |
| The other way: Next shows our data | no | No extension point for `/_next/mcp` tools **[K: `get-or-create-mcp-server.ts` registers a fixed list]**. |

---

## Sources

**Next.js docs and blog**
- Next.js MCP Server (lastUpdated 2026-10-02): <https://nextjs.org/docs/app/guides/mcp>
- AI Coding Agents (in the repository, v16.4.6): `docs/01-app/02-guides/ai-agents.mdx`
- `logging` (v16.4.6): `docs/01-app/03-api-reference/05-config/01-next-config-js/logging.mdx`; online: <https://nextjs.org/docs/app/api-reference/config/next-config-js/logging>
- Next.js 16.3 (2026-08-03): <https://nextjs.org/blog/next-16-3>
- Next.js 16.3: AI Improvements (2026-06-26; smaller MCP server, `get_compilation_issues`, `compile_route`, `next-dev-loop`): <https://nextjs.org/blog/next-16-3-ai-improvements>

**`vercel/next.js` code** (tag `v16.4.6`, compared with `canary` @ v16.5.0-canary.57): <https://github.com/vercel/next.js>
- `packages/next/src/server/mcp/get-or-create-mcp-server.ts`, `get-mcp-middleware.ts`, `tools/*.ts`
- `packages/next/src/server/lib/trace/request-insights.ts`, `span-store.ts`, `local-span-recorder.ts`, `tracer.ts`, `request-insights-identity.ts`
- `packages/next/src/server/lib/patch-fetch.ts` (`trackFetchMetric`, span `AppRender.fetch`)
- `packages/next/src/server/base-server.ts` (headers `x-nextjs-request-id`, `x-nextjs-html-request-id`)
- `packages/next/src/client/components/app-router-headers.ts`, `router-reducer/fetch-server-response.ts`, `router-reducer/reducers/server-action-reducer.ts`, `server/app-render/app-render.tsx` (`self.__next_r`)
- `packages/next/src/server/dev/log-requests.ts`, `dev/browser-logs/file-logger.ts`, `dev/browser-logs/receive-logs.ts`, `dev/next-dev-server.ts`
- `packages/next/src/server/config-shared.ts` (`requestInsights`, `mcpServer`)
- canary: `packages/next/src/shared/lib/request-insights-summary.ts`, changes in `get-request-insights.ts`
- Tool list in tags v16.0.0, v16.1.0, v16.2.0, v16.3.0, v16.4.0 (`git ls-tree`)

**`vercel/next-devtools-mcp` code** 0.4.1 (commit `1e8dcfa`, 2026-09-14): <https://github.com/vercel/next-devtools-mcp>
- `README.md`, `CHANGELOG.md`, `src/_internal/nextjs-runtime-manager.ts`, `src/tools/nextjs_index.ts`, `src/tools/nextjs_call.ts`

**Our repository:** `README.md`, `llms.txt`, `src/mcp/tools.mjs`, `src/outbound-mcp.mjs`, `src/hook/hook.mjs`, `docs/architecture.md`.
