---
status: proposed
date: 2026-11-19
---

# 0003. Apps register themselves, and a launcher adds the flags and reserves the port

## Context

The prototype scans ports 9229–9249. In a monorepo this means planning ports by hand, and a mistake fails silently: a second app on a taken port runs without an inspector. The second silent failure is a process started without the network flag.

Findings from experiments:

- `--experimental-network-inspection` cannot be passed through `NODE_OPTIONS` or Node's config file; it must be on the command line;
- `fork` inherits `execArgv` by default, so the flag from the CLI process reaches the server process;
- `inspector.url()` in the process gives the actual inspector address (also after `inspector.open()`), and returns `undefined` after a failed start;
- a process killed by a signal does not emit the `exit` event.

## Decision

1. **Self-registration.** A process with an active inspector writes its own entry `~/.outbound-inspector/apps/<pid>.json` with `wsUrl`, pid, name, directory and Node version. A module loaded with `--import` does this.
2. **Launcher `outbound run -- <command>`.** It builds the command (network flag and `--import` in `execArgv`, inspector port), reserves a port from 9230–9249 with an atomically created file, starting from a port derived from a hash of the app name, waits for the process to register and warns when it does not. On exit it removes the entries and the reservation.
3. **The collector reads the registry** and shows only processes from the current repository. Port scanning stays until 1.0 as a compatibility mode for processes started by hand.

## Alternatives considered

- **Scanning a port range** (the current state). Solves neither port planning nor silent failures.
- **`--inspect=0` and reading the port from stderr.** Needs stderr captured, which loses the TTY and colors in the terminal.
- **A registry written only by the launcher.** The launcher does not know which process in the tree has the inspector and cannot tell its own app from a foreign process that took the same port.
- **Always port 0.** No races, but the port changes on every start, so `chrome://inspect` must be configured again.
- **The system process list** (`ps`, `lsof`). OS-dependent, slow, fragile.
- **A `node` wrapper on `PATH`.** Works for any command, but instruments every Node tool in the process tree.

## Consequences

- App scripts (`"dev:inspect": "outbound run -- next dev"`) depend on the tool's CLI, so `outbound run` becomes public API.
- A missing inspector is no longer silent: the launcher warns and `inspector_status` gives the reason.
- Two copies of the same app (worktrees) get different ports and do not mix in the collector.
- Stale entries after a hard kill are normal; the collector checks the pid on every read.
- The launcher recognizes only `node` commands, package binaries run by Node and `next dev`. For others it ends with manual instructions.
- To confirm on a real monorepo (M3): `--import` reaches the Next server process, and `next dev --inspect=127.0.0.1:<port>` accepts an address with a host.
