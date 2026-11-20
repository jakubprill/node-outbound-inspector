---
status: proposed
date: 2026-11-19
---

# 0011. Compatibility with the experimental Node flag: capabilities instead of versions, and compatibility probes

## Context

The tool builds on an API Node marks as "1.1 Active development" and on a few internal details. Differences measured between Node 22.23.5 and 24.22.3:

- `fetch` response body: missing on 22 (an empty string without an error), complete on 24;
- request body: `fetch` only on 24, and only with `charset` in `content-type`;
- `undici:request:bodyChunkSent/Received` channels: only on 24;
- body buffer: on 24 about 100 MB per CDP session by default.

Counterintuitive behavior on both versions: `Network.enable` succeeds without the flag, and `wallTime` is in milliseconds. Developers use Node 26, which could not be checked here.

## Decision

1. **Capabilities instead of versions.** For every process the collector determines what works (the flag in `process.execArgv`, response body, request body, `requestId` in hook messages, `Runtime.addBinding`) and shows it in `inspector_status` with the reason and a fix hint. The Node version number is used only in the hint text.
2. **One place that knows CDP.** Only `ingest` knows the shape of `Network.*` events; it normalizes time units and body states.
3. **Compatibility probes.** Every assumption about Node has a test in `test/compat/`. Probes run in a version matrix (22, 24, current) on every change and weekly on nightly. A red probe on nightly is a warning, not a blocker.
4. **Recordings per version.** `ingest` unit tests use event recordings from every supported version.
5. **Support.** Collector and launcher: Node 22 or newer. App process: 22.6 or newer with limitations, 24 or newer recommended.

## Alternatives considered

- **Conditions on the version number** (`if major >= 24`). Simple, but wrong for intermediate versions, backported fixes and future changes.
- **Requiring Node 24 or newer everywhere.** Removes some code branches. Worth considering if the whole team is on Node 24 or newer.
- **Pinning to one Node version.** The tool stops working at a developer's first Node update.
- **No probes, reacting to reports.** We would notice a Node change only once the tool silently stops showing data.

## Consequences

- `inspector_status` becomes the main diagnostic tool: the "symptom, cause, fix" table in README is based on it.
- Probes also detect changes for the better. If the flag became allowed in `NODE_OPTIONS`, the launcher could be simplified.
- If the flag disappeared, the hook could take over collecting metadata from `diagnostics_channel` (without bodies) with no changes to the store, analyzers and MCP layer.
- Maintaining the matrix and recordings is a small, constant cost.

Note (2026-11-19, 0.4.0): the minimum became Node 24 everywhere (see CHANGELOG); Node 22 support was removed.
