---
status: proposed
date: 2026-11-19
---

# 0010. Browser correlation: a marker set by the agent, no trace propagation of our own

## Context

The agent works from two sides: Chrome DevTools MCP shows browser traffic, this tool shows server traffic. They must be linked: "this page visit in this tab caused these server requests". In local dev there is usually one developer, but pages render in parallel, the browser prefetches, and several tabs may be open at once.

Chrome DevTools MCP can set extra HTTP headers for a whole tab (`emulate` with `extraHttpHeaders`) and read response headers (`get_network_request`). The hook sees the page request headers in `http.server.request.start`.

## Decision

1. **Time and URL by default.** The `page_contains` and `last_ms` filters stay and are enough in most cases.
2. **A marker from the agent.** The hook stores the value of the `x-outbound-tag` header from the page request, and the tools accept a `tag` filter. The agent sets the header in the browser and gets only its own tab's traffic.
3. **A response header only when enabled.** The hook can add `x-outbound-page-request: <id>` to the response to link a single request.
4. **Reading existing ids only.** If the page request or an outbound request carries `traceparent` or `x-request-id`, the value goes into the record.
5. **We add nothing to outbound requests.**

The hook reads the page request kind (document, RSC, Server Action, Route Handler) and the action id from Next's headers. Mapping the action id to a file is left to Next DevTools MCP.

## Alternatives considered

- **Our own `traceparent` propagation** to internal services. Would link to their logs, but a diagnostic tool would change traffic to integrations. That is OpenTelemetry's job in the app.
- **`Server-Timing` with analysis results.** Response headers leave before the requests finish (streaming), so the result cannot fit in them.
- **A response header on by default.** A certain link without the agent's help, but it changes the app's responses and its tests may notice.
- **Next's internal ids.** Undocumented.

## Consequences

- The most reliable correlation needs one extra step from the agent. The `instructions` field and the docs describe it.
- A header set in the browser also goes to its requests to other domains, which can trigger a CORS preflight. The docs warn about this.
- The `rsc`, `next-action` and `next-router-prefetch` headers are an assumption to confirm on a real app (M7).
