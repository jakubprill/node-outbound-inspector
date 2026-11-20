---
status: proposed
date: 2026-11-19
---

# 0002. The collector runs in the MCP server process, in memory, without a daemon

## Context

An MCP client starts a stdio server as its own child process, so every agent session (a second window, a second editor, a second worktree) is a separate `outbound mcp` process. The Node inspector accepts many CDP sessions at once and each gets the same events. We must decide whether one shared process collects the traffic or each client does it itself.

## Decision

Every `outbound mcp` process (and `outbound tail`) has **its own collector**: its own CDP sessions and its own in-memory store. Nothing is written to disk. The core (`createCollector`) does not know the transport, so a shared process can be added later without changing the store or the analyzers.

## Alternatives considered

- **A shared daemon** serving many clients. Gives history from before the agent session started and one fetch of every body. Rejected for now: we would have to solve who starts and stops it, version compatibility between daemon and clients, a local socket with access control, and dead daemons after a crash. That is more code than the rest of the tool.
- **Writing traffic to disk** (NDJSON, SQLite). Gives history and export. Rejected: integration response bodies and secrets would land in files, plus cleanup and a dependency. Event recording stays only as a developer script for creating test data.

## Consequences

- The buffer starts when the agent session starts. The recommended workflow: clear, reproduce the scenario, analyze.
- Many agent sessions mean many CDP sessions per app. The hook must therefore support many receivers at once ([ADR 0004](0004-preload-hook-push-and-requestid-join.md)), and each session has its own body buffer in the app process, hence explicit limits.
- We return to the daemon when three or more parallel sessions become normal, when history from before the session is needed, or when the overhead of many sessions becomes measurable.
