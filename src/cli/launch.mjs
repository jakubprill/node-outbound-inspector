// Portable launching of a CLI under Node with the network inspection flag (the seed of the `outbound run` launcher from M3).
// Replaces the `$(node -p "require.resolve(…)")` construct in `dev:inspect` scripts, which cmd.exe does not understand:
// Node resolves the CLI path here, and the child process starts without a shell (spawn with process.execPath).
// Importing the module has no side effects; everything happens only in runNext().
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';

export const NETWORK_FLAG = '--experimental-network-inspection';
export const NEXT_CLI = 'next/dist/bin/next';
const TAG = '[outbound-next]';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * The CLI file to run: `OUTBOUND_NEXT_BIN` (a path relative to cwd; for tests and unusual layouts)
 * or `next/dist/bin/next` resolved the way `require` from a package in cwd would. Works for
 * hoisted node_modules (npm, bun, yarn), pnpm symlinks and Yarn PnP (hook from NODE_OPTIONS).
 * @param {{ cwd: string, env: Record<string, string | undefined> }} input
 */
export function resolveCli({ cwd, env }) {
  if (env.OUTBOUND_NEXT_BIN) return path.resolve(cwd, env.OUTBOUND_NEXT_BIN);
  return createRequire(path.join(cwd, 'package.json')).resolve(NEXT_CLI);
}

/**
 * Arguments for `node`: the current process's flags (without the inspector — the inspector port belongs to the app,
 * and an inherited fixed port would give `address already in use`), the network flag, the CLI file, CLI arguments.
 * The flag must be on the command line: Node rejects it in NODE_OPTIONS.
 * @param {{ cli: string, args: string[], execArgv?: string[] }} input
 */
export function buildNodeArgs({ cli, args, execArgv = [] }) {
  const inherited = execArgv.filter(a => !/^--(inspect|debug-port)/.test(a) && a !== NETWORK_FLAG);
  return [...inherited, NETWORK_FLAG, cli, ...args];
}

/**
 * Warnings about `--inspect` arguments passed to Next (Next itself opens the inspector in the right
 * process). Without `--inspect` the network flag does nothing; a non-loopback host exposes full control
 * over the process on the network. A port alone (`--inspect=9231`) means 127.0.0.1.
 * @param {string[]} args
 * @returns {string[]}
 */
export function inspectWarnings(args) {
  const values = inspectorValues(args, /^--inspect(?:-brk|-wait)?(?:=(.*))?$/);
  if (!values.length) return ['No --inspect=<port> in the arguments: the process will have no inspector, so network inspection does nothing. Add e.g. --inspect=9231 (each app in a monorepo needs its own port).'];
  const warnings = remoteInspectHosts(args).map(host =>
    `The inspector on ${host} is reachable from outside this machine and gives full control over the process. Locally, use just the port (--inspect=<port> → 127.0.0.1).`);
  // --inspect without a port → 9229: the outbound-hub port, outside the collector's default range; in a monorepo (also
  // `portless -- --inspect`) all apps want 9229 and one wins, the rest run without an inspector
  if (values.some(v => !/(^|:)\d+$/.test(v))) warnings.push('--inspect without a port uses 9229: that is the outbound-hub port and outside the collector\'s default range (9230-9249), '
    + 'and in a monorepo every app would want it (only one gets it, the rest run without an inspector). Give each app its own port, e.g. --inspect=9231.');
  return warnings;
}

const INSPECT_ANY = /^--(?:inspect(?:-brk|-wait)?|inspect-port|debug-port)(?:=(.*))?$/;

/** Inspector flag values: `--flag=v` or `--flag v` (when the next argument is not a flag). */
function inspectorValues(args, re) {
  return args.flatMap((a, i) => {
    const m = re.exec(a);
    if (!m) return [];
    return [m[1] ?? (args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : '')];
  });
}

/** Host from a flag value: port only → no host; `[::]:9229`; `0.0.0.0:9229`; host only (`--inspect=0.0.0.0`). */
export function inspectorHost(v) {
  if (!v || /^\d+$/.test(v)) return '';
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  const i = v.lastIndexOf(':');
  return i >= 0 ? v.slice(0, i) : v;
}

/**
 * Non-loopback inspector hosts in the arguments and in NODE_OPTIONS, also `--inspect=0.0.0.0` (host only)
 * and `--inspect-port` / `--debug-port` (audit B-08).
 * @param {string[]} args  @param {Record<string, string | undefined>} [env]
 */
export function remoteInspectHosts(args, env = {}) {
  const all = [...args, ...String(env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  return [...new Set(inspectorValues(all, INSPECT_ANY).map(inspectorHost).filter(h => h && !LOOPBACK.has(h)))];
}

/** Signals forwarded immediately. SIGBREAK exists only on Windows (Ctrl+Break). */
const forwarded = platform => ['SIGTERM', 'SIGHUP', ...(platform === 'win32' ? ['SIGBREAK'] : [])];

/**
 * Runs `node <nodeArgs>` with inherited stdio (TTY, colors) and waits for it to end.
 * SIGTERM, SIGHUP (and SIGBREAK on Windows) reach the child immediately. SIGINT from the terminal goes to the whole
 * process group (on Windows: all console processes), so it is not duplicated; if it reached only us
 * (e.g. from a tool that kills just the pid), we forward it after `sigintGraceMs`.
 * @param {{ execPath: string, nodeArgs: string[], proc?: NodeJS.Process, sigintGraceMs?: number,
 *   spawnImpl?: typeof spawn }} input
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, error?: Error }>}
 */
export function runChild({ execPath, nodeArgs, proc = process, sigintGraceMs = 1500, spawnImpl = spawn }) {
  return new Promise(resolve => {
    // OUTBOUND_INSPECT=1: explicit consent to inspection for the collector (audit B-01); next's child processes inherit it
    const child = spawnImpl(execPath, nodeArgs, { stdio: 'inherit', env: { ...proc.env, OUTBOUND_INSPECT: '1' } });
    const alive = () => child.exitCode === null && child.signalCode === null;
    const send = sig => { if (alive()) try { child.kill(sig); } catch { /* the process just ended */ } };
    const handlers = Object.fromEntries(forwarded(proc.platform).map(sig => [sig, () => send(sig)]));
    let graceTimer;
    handlers.SIGINT = () => { graceTimer ??= setTimeout(() => send('SIGINT'), sigintGraceMs); graceTimer.unref?.(); };
    for (const [sig, h] of Object.entries(handlers)) proc.on(sig, h);
    const done = result => {
      clearTimeout(graceTimer);
      for (const [sig, h] of Object.entries(handlers)) proc.off(sig, h);
      resolve(result);
    };
    child.once('error', error => done({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

/**
 * Reproduces how the child ended: the exit code or the same signal (POSIX). Windows has no POSIX
 * signals, so the process ends with code 128 + the signal number, as in shells.
 * @param {{ code: number | null, signal: NodeJS.Signals | null }} result
 */
export function exitLike({ code, signal }, proc = process) {
  if (signal) {
    if (proc.platform !== 'win32') proc.kill(proc.pid, signal);   // our listeners already removed → default action
    return proc.exit(128 + (constants.signals[signal] ?? 0));
  }
  return proc.exit(code ?? 1);
}

/**
 * Entry point of `outbound-next`: `outbound-next dev --port 3101 --inspect=9231`.
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, cwd?: string, proc?: NodeJS.Process }} [input]
 */
export async function runNext({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), proc = process } = {}) {
  const fail = msg => { proc.stderr.write(`${TAG} ${msg}\n`); return proc.exit(1); };
  if (proc.versions.bun) return fail('Bun as a runtime is not supported (WebKit Inspector instead of CDP). Run the script without --bun; Bun can stay as the package manager.');
  const [major] = proc.versions.node.split('.').map(Number);
  if (major < 24) return fail(`Node ${proc.versions.node} is not supported. Node ≥ 24 is required.`);
  let cli;
  try {
    cli = resolveCli({ cwd, env });
  } catch (e) {
    return fail(`Could not find ${NEXT_CLI} from ${cwd} (${e.code ?? e.message}). Run the script in an app directory that depends on "next", or point to the file with OUTBOUND_NEXT_BIN.`);
  }
  // an inspector outside loopback gives anyone on the network code execution in the process: blocked unless explicitly allowed
  const remote = remoteInspectHosts(argv, env);
  if (remote.length && env.OUTBOUND_ALLOW_REMOTE_INSPECT !== '1') {
    return fail(`The inspector would listen on ${remote.join(', ')}, reachable from outside this machine, which gives full control over the process. `
      + 'Use just the port (--inspect=<port> → 127.0.0.1). To allow it anyway (e.g. inside a container), set OUTBOUND_ALLOW_REMOTE_INSPECT=1.');
  }
  for (const w of inspectWarnings(argv)) proc.stderr.write(`${TAG} warning: ${w}\n`);
  const result = await runChild({ execPath: proc.execPath, nodeArgs: buildNodeArgs({ cli, args: argv, execArgv: proc.execArgv }), proc });
  if (result.error) return fail(`Could not start ${proc.execPath}: ${result.error.message}`);
  return exitLike(result, proc);
}
