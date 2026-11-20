---
status: proposed
date: 2026-11-19
---

# 0006. The collector resolves source maps with the built-in `SourceMap` from `node:module`

## Context

Stack frames point at compiled chunks (`.next/dev/server/chunks/ssr/*.js`), while the agent needs the source file and line. `.map` files sit next to the chunks. Since Next 16.1, Turbopack writes relative paths in server code maps. The `SourceMap` class from `node:module` handles regular and index maps (`sections`) on Node 22 and 24.

## Decision

The hook sends generated positions. **The collector** reads `//# sourceMappingURL=` from the end of the chunk, loads the map from disk and translates the position with `SourceMap`. It stores the result in the record right after receiving the message. The map cache is keyed by path and modification time. When the chunk is newer than the request, the result gets `stale: true`.

Supported source paths: relative to the map, `file://`, `turbopack:///[project]/…`, `webpack://…`. For webpack in dev mode (modules in `eval`, the map in a `data:` URL) only the file derived from the frame URL is given.

## Alternatives considered

- **Resolving in the app process** (`--enable-source-maps`, `module.findSourceMap`). Changes how the app formats stacks and adds work in its process. Against the minimal-footprint principle.
- **The Debugger domain** (`scriptParsed` with the map URL). Would handle webpack's inline maps, but needs a domain the collector must never enable.
- **A library** (`@jridgewell/trace-mapping`, `source-map`). Faster with large maps, but the first runtime dependency. To consider only when measurements show a problem.
- **Next's internal endpoint for mapping frames.** An undocumented dev server API.

## Consequences

- Zero dependencies and no work in the app process.
- The collector must see the app's file system. In local dev this is always true.
- HMR can rebuild a chunk between capture and resolution. The window is short, and the case is marked.
- Full webpack mapping is out of scope.
- The Turbopack map format of Next 16.4 was not checked in this environment. With an unreadable map, the result contains the chunk path and `mapped: false`.
