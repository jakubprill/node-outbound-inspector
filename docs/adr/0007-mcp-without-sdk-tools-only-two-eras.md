---
status: proposed
date: 2026-11-19
---

# 0007. MCP layer without an SDK: tools only, a server supporting both protocol eras

## Context

The prototype implements MCP by hand: `initialize`, `ping`, `tools/list`, `tools/call` over stdio, about 30 lines. We need tools only and stdio only.

The current spec revision (2026-07-28) is stateless: it drops `initialize`, requires `server/discover` and version metadata in every request, and results have a `resultType` field. According to the spec's compatibility table:

- a client of both eras probes a stdio server with `server/discover` and falls back to `initialize` on any non-modern error, so the prototype works with such a client;
- a new-era-only client does not work with an old-era server.

Spec revisions come out about twice a year.

## Decision

We stay without an SDK. `mcp/server.mjs` (about 150 lines) supports **both eras**: the `initialize` handshake and the stateless mode (`server/discover`, per-request metadata, `resultType`, the unsupported-version error). We expose only tools and the `instructions` field. `handle(message)` is pure, so the protocol is tested without processes.

**When we move to the official SDK** (any one condition):

1. an HTTP transport is needed;
2. features beyond tools are needed: tasks, multi-round requests, subscriptions;
3. a second spec revision in a row needs changes larger than about 100 lines;
4. the compatibility test with the official client fails and the fix is not obvious.

The switch touches one file: `mcp/tools.mjs` does not know the protocol.

## Alternatives considered

- **The official TypeScript SDK** (v1 `@modelcontextprotocol/sdk` or the v2 packages). Someone else keeps spec compliance. Rejected for now: the tool sees secrets and controls developer processes, so every dependency is attack surface; plus install time and our own migrations between SDK versions. We use a fraction of its features.
- **Staying with the `initialize` era only.** No work today, but the tool will stop working with clients that drop the old era.
- **MCP resources and prompts.** Resources have uneven client support, and the data depends on filters. Prompts are replaced by the `instructions` field.

## Consequences

- We track the spec ourselves. Protocol tests for both eras are mandatory; a test with the official client can run in CI as a development-only dependency.
- The tool stays readable as a whole and runs without installing anything.
- The decision is reversible at low cost, as long as `mcp/tools.mjs` does not start relying on protocol details.
