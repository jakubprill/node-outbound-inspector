---
status: proposed
date: 2026-11-19
---

# 0012. Code: ESM modules without a build step or dependencies; distributed as a monorepo devDependency

## Context

The prototype is a single `.mjs` file without dependencies, run directly by Node. The target version has about 25 files and three places where it runs: the collector process, the launcher and the code in the app process. All three must be the same version, because the registry format and the hook protocol connect them. The team uses Bun as the package manager; the tool's repository is private.

## Decision

1. **Plain ESM modules (`.mjs`), no build step.** Types in JSDoc; type checking (`tsc --checkJs`) can run in CI as a development-only dependency.
2. **Zero runtime dependencies.** Everything needed is in Node 22: `WebSocket`, `fetch`, `node:test`, `util.parseArgs`, `SourceMap`, `diagnostics_channel`.
3. **A pure core, I/O at the edges, one composition root.** Importing a module has no side effects. `hook/*` imports only `node:` modules and `registry.mjs`.
4. **One executable** `outbound` with the commands `mcp`, `run`, `status`, `tail`. `src/outbound-mcp.mjs` stays as an alias until 1.0.
5. **Distribution:** a devDependency in the monorepo root, pinned to a tag (a git dependency or an internal registry). App scripts call `outbound run`, and `.mcp.json` in the repository points to the path in `node_modules`.

## Alternatives considered

- **TypeScript with compilation.** Better types and tooling, but adds a build step, an output directory and publishing artifacts; installing from git stops being trivial. The hook sent as function text would have to be written carefully anyway.
- **A single file as today.** The simplest distribution, but at this size the parts cannot be tested separately, and importing starts timers and sockets.
- **A package on public npm and `npx`.** Convenient outside the team. Needs a decision about going public and a name; `npx` with a short name risks fetching a foreign package.
- **Global installation.** Launcher, hook and collector could drift apart in versions between developers.

## Consequences

- The code in the repository is the code that runs: there are no artifacts to track.
- The tool version is recorded in the monorepo lockfile, so the whole team has the same one.
- No compiler means discipline: JSDoc, small modules, contract tests between modules.
- The dependency rule is a convention. A "no side effects on import" test and code review enforce it.
- Publishing to npm stays possible without code changes.

Note (2026-11-20, 0.7.0): the package now exposes `exports` (`./hub`, `./package.json`) with the programmatic hub API (issue #9).
