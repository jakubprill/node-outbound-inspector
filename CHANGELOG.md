# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Changed
- Documentation is now in English: CHANGELOG, ADRs, architecture, security audit, Next DevTools MCP comparison, test results and reports. ADR files were renamed to English slugs.

## [0.7.0] — 2026-11-20

### Changed (breaking): app names without the npm scope (issue #8)
- Shown names drop the npm scope: `@acme/web` → `web` (status, request rows, analysis keys, `chrome://inspect`). When two apps would share a short name (`@a/web`, `@b/web`), both get full names, also in already collected records, regardless of start order. `APP_NAME_STRIP_SCOPE=0` restores full names.
- An app running under [portless](https://github.com/vercel-labs/portless) is named as in portless (`PORTLESS_URL`: `http://web.localhost:1355` → `web`).
- The `app` filter accepts the shown name, the full package name, the name without scope and the inspector port; `APP_NAMES` is usually no longer needed.

### Added
- **Programmatic hub API (issue #9):** `import { startHub } from 'node-outbound-inspector/hub'`. Returns status `listening` / `already-running` / `port-taken` (with `holder`) instead of calling `process.exit`; `close()` is safe for every status; no signal handlers. Works under Bun too (checked on 1.4.4: discovery, names, DevTools forwarding). Types in `src/hub/api.d.ts`; `package.json` has `exports` (`./hub`, `./package.json`). `bin/outbound-hub.mjs` is a thin wrapper around the API.
- `outbound-next` warns about `--inspect` without a port (9229: the hub's port, outside the collector's range, collides in a monorepo, e.g. `portless -- --inspect`).
- README and `llms.txt`: portless section with test results (Next 16.4, portless 0.18.1); `docs/portless.md`, `docs/staging-built-app.md`.

## [0.6.0] — 2026-11-20

### Changed (breaking): fewer tokens
- **`analyze_server_timeline` summary**: a `pages` field instead of `by_page_request` — one entry per page (repeated visits grouped: `visits`, `wall_ms_median`, `wall_ms_max`), numbers and codes only (`verdict_code`, `potential_saving_ms` that accounts for dependencies, `errors`), no verdict text, steps or hints; one `hint` per result. Up to 5 errors, 5 bursts without a page, 3 slow requests. Full data unchanged under `page_request_id` and `detail: "full"` (`by_page_request`). For 120–1000 requests: about 1.2–1.4k tokens instead of 5.5k.
- `list_server_requests`: 20 rows by default (was 50). `get_server_request`: 2000 body characters by default (was 4000).
- Shorter tool and parameter descriptions: definitions are about 1.1k tokens.

### Security (review of 2026-11-20, `docs/security-audit-2026-11-20.md`)
- **Changed (breaking): inspection only with consent (B-01).** The collector injects code, patches and enables network inspection only in processes of the same user that gave consent: `outbound-next` (sets `OUTBOUND_INSPECT=1`), `OUTBOUND_INSPECT=1` or `--experimental-network-inspection`. Others: `skipped` in `inspector_status`. Default collector and hub ports: **9230–9249** (without 9229).
- **Changed (breaking): `outbound-next` refuses an inspector outside loopback (B-08)**, including `--inspect=0.0.0.0`, `--inspect-port`, `--debug-port` and `NODE_OPTIONS`; exception: `OUTBOUND_ALLOW_REMOTE_INSPECT=1`.
- Redaction: page request URL (B-02); URLs in headers, passwords in URLs, fragments, short and camelCase names, known token formats (B-05); bodies as a JSON tree, truncated JSON, form-urlencoded, redaction before truncation (B-06); no raw bytes of undecoded bodies (B-10).
- Resilience against a fake inspector: `webSocketDebuggerUrl` validation (B-03), malformed data does not crash the collector (B-04), safe `package.json` read (B-09), resource limits (B-11).
- Untrusted data: marked in tool descriptions and `instructions`, app names and control characters cleaned (B-07). Process identity without `argv` (B-16).
- README and `llms.txt`: "Security model" section; ADR 0009 accepted with an implementation section.

### Added
- **Working with Next DevTools MCP:** page requests carry `next_request_id` and `next_html_request_id` from the `x-nextjs-request-id` / `x-nextjs-html-request-id` headers (join with `get_request_insights`; also as filters), `inspector_status` lists the apps' `http_ports` (for `nextjs_index` / `nextjs_call`), requests to Next's internal dev endpoints (`/_next/mcp`, HMR, `/__nextjs_*`) are not page requests. "Together with Next DevTools MCP" section in README and `llms.txt`.
- **`outbound-hub`:** all apps in `chrome://inspect` without typing ports. Listens on `127.0.0.1:9229` (checked by Chrome by default), finds processes with an inspector on the scanned ports, names them like the collector and forwards the DevTools connection to the right process (TCP after the Upgrade headers, no dependencies). Answers only a `Host` that is an IP address or `localhost` and connects only to processes it found. Checked on Chrome 153: target list and "inspect". The MCP collector skips the hub's targets (`outboundHub` field), so apps are not listed twice.

### Fixed
- Tests on Windows (issue #7): golden normalization turns `\` into `/` before replacing the root directory; the hook test ends the process by closing servers instead of `process.exit()` (on Windows, exiting with open keep-alive connections crashes libuv); `npm test` and `npm run golden:update` work in `cmd.exe`.
- CI also runs the tests on Windows and macOS (Node 24).

## [0.5.0] — 2026-11-19

### Changed (breaking since 0.4.0)
- **`list_server_requests` returns an object** `{ requests, next_since_id }` instead of an array, with `has_more`/`remaining` when paging and `older_not_shown` when older rows were left out. The object lets the result carry a cursor and a truncation marker.
- **`analyze_server_timeline` returns a summary by default** (M6, ADR 0008): the 20 newest page requests without `timeline`, up to 10 errors (`errors_total` when there are more), up to 10 bursts without a page, `detail: "summary"`. The full report with `page_request_id` or `detail: "full"`. Fields used so far (`by_page_request`, `verdict`, `verdict_code`, `sequential_chains`, `errors`, `in_flight`) stay.
- Tool results are JSON without indentation. In lists and analysis, a query string longer than 80 characters is shortened to `?…`; `get_server_request` returns the full URL.
- The secret-name rule no longer matches `author…` (`auth(?!or)`).

### Added
- **Hard response budget** (defect 5, M6): every result fits in `OUTBOUND_MAX_RESPONSE_CHARS` (20,000 characters by default). A truncated result has `truncated: true` and `truncation_hint`. The oldest elements of the largest arrays are trimmed first. Property test on random stores of up to 5000 requests; 132 requests give a summary under 6000 characters.
- `list_server_requests`: cursor (`since_id` → `next_since_id`, every record exactly once), filters `page_request_id` and `status` (`404`, `5xx`, `error`, `failed`, `pending`; also in `analyze_server_timeline`).
- `get_server_request`: body paging (`body_offset`, `body_next_offset`), full URL.
- `analyze_server_timeline`: `settle_ms` (waits until nothing is in flight and traffic is quiet, at most 15 s; the result has `settle`), findings `findings.duplicates` (same method and URL within a page request or burst) and `findings.slow` (`slow_ms`, 1000 by default).
- **Secret redaction in JSON bodies:** scalar values of fields with secret-like names (`access_token`, `client_secret`, `password`, …) are replaced with a description at ingestion, also in a truncated body; `body_redacted_fields` in `get_server_request`.
- **MCP 2026-07-28 era** next to `initialize`: `server/discover`, client version and capabilities in `_meta` of every request, `resultType: "complete"` and `serverInfo` in `_meta` of results, error `-32022` for an unsupported version, `-32602` when required fields are missing.

## [0.4.0] — 2026-11-19

### Added
- `llms.txt` (English): instructions for AI agents (project integration, including a custom script that spawns the apps, verification, tools, caveats).
- README in English (`README.md`) and Polish (`README.pl.md`) with a language switch.

### Changed (tool contract)
- **MCP tools speak English:** tool and parameter descriptions, server `instructions`, verdicts (`SEQUENTIAL`/`PARALLEL`/`MIXED`/`single request`), hints, body state reasons, warnings, errors and the redaction description (`[redacted: Bearer · 19 chars · #a1b2c3]`). `outbound-next` messages, collector logs and the demo script are English too. Fields and codes (`verdict_code`, `body_state`, `error_kind`) are unchanged, so logic based on codes keeps working.

### Changed
- **The minimum Node version is 24** (`engines`, CI on 24 and the latest). Node 22 support was removed:
  - the collector (`outbound-mcp`) and `outbound-next` refuse to start on Node < 24;
  - an app process on Node < 24 is not inspected, and `inspector_status` gives the reason;
  - code and the event recording for Node 22 were removed;
  - an event recording from Node 24 was added.

### Fixed
- **Attaching the collector broke the connections of an app** reading `node:http` responses after `res.setEncoding()`. This is Node bug [#66551](https://github.com/nodejs/node/issues/66551), verified on Node 24.22.3: `TypeError: Missing dataLength in event`, and the app gets no response. The collector installs a workaround in the app process before `Network.enable` (`src/hook/node-fixes.mjs`), and `inspector_status` shows it in the new `node_workarounds` field.

### Fixed (issues #1–#6)
- **#1** Bodies with `content-encoding` (gzip, x-gzip, br, deflate zlib/raw, zstd) are decompressed. Multi-step encoding and letter case are handled, and an output limit protects against decompression bombs (state `truncated`). Truncation is detected from compressed bytes. New fields `body_encoding` and `body_encoded_bytes`. A broken or unknown encoding gives state `skipped` with a reason. A response with `charset` in `content-type`, which the Node inspector turns into garbled text, has state `unavailable`.
- **#2** The call site (`origin`) skips frames of any library: every `node_modules/`, pnpm, Yarn PnP and Turbopack chunks with libraries (`node_modules_…`, `…__pnpm_…`, `[turbopack]_runtime`, `[externals]_…`, `__next-internal_`). It also skips `vendor-chunks/` and the webpack runtime, and Windows paths are normalized. `[root-of-the-server]__…` chunks stay because they contain app code (checked on Next 16.4). New variable `OUTBOUND_LIBRARY_PATHS`.
- **#3** A failed request without an error text has status `FAILED (no error text from the inspector)` instead of `FAILED: `. The cause is an `AggregateError` when `localhost` resolves to both IPv4 and IPv6. `get_server_request` also returns `error_kind` (e.g. `connection_refused`, `timeout`) and `error_hint`.
- **#4** OpenTelemetry export (`/v1/traces|metrics|logs` on port 4318, OTLP/gRPC `…Service/Export`) is skipped by default. `OUTBOUND_IGNORE_OTLP=0` turns this off. `inspector_status` shows the rules (`ignored_otlp`) and counters of skipped requests (`ignored_requests_total`).
- **#5** The new `outbound-next` command runs `next` with network inspection without a shell. Works in `cmd.exe` and PowerShell, with npm, pnpm, Yarn and Bun. README and the monorepo example were updated, and README also describes the relative-path variant.
- **#6** The analysis detects data dependencies between requests: a value from response A appears in the URL or headers of B. Dependent steps do not count toward savings, and `hint` does not suggest `Promise.all`. New fields `dependencies` and `dependency_check` (`complete`, `partial` or `unavailable` when bodies are missing).

### Known limitations (found while fixing the issues)
- `node:http`: when the connection breaks while the body is being received, the Node inspector sends neither `loadingFinished` nor `loadingFailed`, so the request stays in flight.

### Fixed (M2 — core correctness and security)
- **Defect 2:** a process without `--experimental-network-inspection` is no longer reported as working. `inspector_status` checks the flag in `process.execArgv` (because `Network.enable` succeeds without it too) and gives the reason in `warnings`.
- **Defect 3:** the record key is the connection number (`processId`) and `requestId`, not the port, so records from before an app restart on the same port are kept.
- **Defect 4:** the response body has an explicit state (`body_state`: `available`, `truncated`, `unavailable`, `evicted`, `skipped`, `none`) and a reason (`body_reason`) instead of an empty string. On Node < 24 a `fetch` body has state `unavailable`, and the status shows a warning. Binary bodies are not decoded as UTF-8.
- **Defect 6:** secret redaction at ingestion. Authentication headers (`authorization`, `cookie`, `set-cookie`, `x-api-key`, …) and headers and URL parameters with names matching the pattern (`token`, `secret`, `password`, `session`, `key`, `auth`, …) are replaced with a description `[redacted: Bearer · 19 chars · #a1b2c3]`. The digest is an HMAC with a key drawn when the collector starts.

### Added (M2)
- Body modes `OUTBOUND_BODIES=eager|lazy|off`, a per-response body limit (`OUTBOUND_BODY_MAX_KB`, 256) and a budget for all bodies in the collector (`OUTBOUND_BODIES_TOTAL_MB`, 32; the oldest bodies of successful responses go first).
- Own body buffer limits in the app process at `Network.enable` (`OUTBOUND_INSPECTOR_BUFFER_MB` 32, `OUTBOUND_INSPECTOR_RESOURCE_MB` 2), instead of the default of about 100 MB per session.
- `OUTBOUND_REDACT=0` (turns redaction off, with a warning in the status) and `OUTBOUND_REDACT_HEADERS` (extra company headers).
- Additive result fields: `inspector_status` → `apps[].node`, `apps[].ready`, `apps[].warnings`, `redaction`, `bodies`, `warnings`; `get_server_request` → `body_state`, `body_bytes`, `body_reason`, `ttfb_ms`; `analyze_server_timeline` → `in_flight` (+ `in_flight_requests`), `verdict_code` (`single`, `sequential`, `parallel`, `mixed`).
- MCP: a list of supported protocol versions instead of echoing any version, an `instructions` field with the recommended workflow and a warning that the contents are data, and the server version taken from `package.json`.
- `wallTime` normalization (seconds or milliseconds).
- Event recordings with response bodies, from Node 22 and Node 26.

### Changed (M2)
- `get_server_request`: when the body is not available, `body` is `null` (an empty string before). The reason is in `body_state` and `body_reason`.

### Changed (M1 — refactor without behavior change)
- `src/outbound-mcp.mjs` split into modules following `docs/architecture.md`: `config`, `discovery`, `cdp-client`, `session`, `ingest`, `store`, `correlate`, `frames`, `analyze/*`, `hook/hook`, `mcp/server`, `mcp/tools`, `mcp/render`, with `collector.mjs` as the composition root. Tools, results, environment variables and the entry point path are unchanged.

### Added
- Characterization (golden) tests of the MCP tool contract: `test/golden/`, refreshed with `npm run golden:update`.
- Unit tests of pure modules (`test/unit/`), including replays of CDP event recordings.
- `scripts/record-fixture.mjs` (`npm run record`): records raw inspector traffic to NDJSON. First recording: Node 22.
- Known prototype defects as `todo` tests (`test/e2e/known-defects.test.mjs`) — to be fixed in M2.
- CI: matrix of Node 22, 24 and the current version.

## [0.3.0] — 2026-11-19
First version in the repository (prototype).

### Added
- `src/outbound-mcp.mjs`: MCP server (stdio, no dependencies) that attaches to Node inspectors started with `--experimental-network-inspection`.
- Several apps at once: scanning a port range and recognizing apps by `npm_package_name`, `package.json` in `cwd` or `APP_NAMES`.
- Assigning outbound requests to the page request (`diagnostics_channel` and `AsyncLocalStorage`, no changes in the app).
- Timeline analysis: sequential (waterfall), parallel and mixed requests, possible saving from `Promise.all`, 4xx/5xx errors and broken connections.
- Tools: `inspector_status`, `list_server_requests`, `get_server_request`, `analyze_server_timeline`, `clear_server_requests`.
- E2E tests (two apps started in parallel), a Next.js monorepo example, a demo script, analysis and test-result documents.

[Unreleased]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/jakubprill/node-outbound-inspector/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/jakubprill/node-outbound-inspector/releases/tag/v0.4.0
