---
status: proposed
date: 2026-11-19
---

# 0001. The traffic data source is Node's built-in network inspection (CDP)

## Context

The tool must show people (Chrome DevTools) and agents (MCP) the outbound requests of a Node process: URL, headers, status, body, timings. Node has the `--experimental-network-inspection` flag, which sends `Network.*` events to every attached CDP client. The prototype already builds on it.

Experiments showed its costs: it cannot be passed through `NODE_OPTIONS` or Node's config file, `Network.enable` pretends to succeed without the flag, the `fetch` response body is available only from Node 24, request bodies are only partly available, and Node buffers bodies in the app process separately for every CDP session. Node's documentation marks this part of the API as "1.1 Active development".

## Decision

We stay with built-in network inspection as the **only source of data about the traffic itself**. Our own code in the app process (the hook) only enriches records with what Node does not know: the page request, the call site, the marker. Only the `ingest` module knows the shape of CDP events.

## Alternatives considered

- **Our own in-process agent collecting everything from `diagnostics_channel`**, loaded with `--import` (allowed in `NODE_OPTIONS`). No experimental flag and no launcher needed. Rejected as the primary source: response bodies would have to be captured from streams ourselves, DevTools would show nothing, and much more of our code would run in the app process. Kept as a fallback (metadata without bodies) in case the flag disappears.
- **An intercepting proxy** (mitmproxy, HTTP Toolkit). Runtime-independent, but needs undici and `http`/`https` redirected, certificates for HTTPS, and knows neither the page request nor the code. Rejected.
- **OpenTelemetry + Jaeger.** A different goal: timings and flow between services, also outside dev. No bodies by default. A complement, not a replacement.
- **Next.js mechanisms** (`logging.fetches`, `experimental.requestInsights` from Next DevTools MCP). Next only and `fetch` only; they do see cache behavior. A complement; worth comparing before M6.

## Consequences

- The flag must be on the process command line, hence the launcher ([ADR 0003](0003-registry-self-registration-and-launcher.md)).
- People and agents look at the same data: the DevTools Network tab and the MCP tools share one source.
- Node's limitations become the tool's limitations. The collector detects and names them instead of guessing ([ADR 0011](0011-compatibility-with-experimental-node-flag.md)).
- The collector always passes buffer limits to `Network.enable`, so the app's memory does not grow uncontrolled.
