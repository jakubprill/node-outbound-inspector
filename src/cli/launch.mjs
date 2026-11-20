// Przenośne uruchamianie CLI pod Node z flagą inspekcji sieci (zalążek launchera `outbound run` z M3).
// Zastępuje w skryptach `dev:inspect` konstrukcję `$(node -p "require.resolve(…)")`, której nie rozumie cmd.exe:
// ścieżkę do CLI rozwiązuje tu Node, a proces potomny startuje bez powłoki (spawn z process.execPath).
// Import modułu nie ma efektów ubocznych; wszystko dzieje się dopiero w runNext().
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import path from 'node:path';

export const NETWORK_FLAG = '--experimental-network-inspection';
export const NEXT_CLI = 'next/dist/bin/next';
const TAG = '[outbound-next]';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Plik CLI do uruchomienia: `OUTBOUND_NEXT_BIN` (ścieżka względem cwd; dla testów i nietypowych układów)
 * albo `next/dist/bin/next` rozwiązane tak, jak zrobiłby to `require` z pakietu w cwd. Działa dla
 * node_modules wynoszonych w górę (npm, bun, yarn), symlinków pnpm i Yarn PnP (hak z NODE_OPTIONS).
 * @param {{ cwd: string, env: Record<string, string | undefined> }} input
 */
export function resolveCli({ cwd, env }) {
  if (env.OUTBOUND_NEXT_BIN) return path.resolve(cwd, env.OUTBOUND_NEXT_BIN);
  return createRequire(path.join(cwd, 'package.json')).resolve(NEXT_CLI);
}

/**
 * Argumenty dla `node`: flagi bieżącego procesu (bez inspektora — port inspektora należy do aplikacji,
 * a odziedziczony stały port dałby `address already in use`), flaga sieciowa, plik CLI, argumenty CLI.
 * Flaga musi stać w linii poleceń: Node odrzuca ją w NODE_OPTIONS.
 * @param {{ cli: string, args: string[], execArgv?: string[] }} input
 */
export function buildNodeArgs({ cli, args, execArgv = [] }) {
  const inherited = execArgv.filter(a => !/^--(inspect|debug-port)/.test(a) && a !== NETWORK_FLAG);
  return [...inherited, NETWORK_FLAG, cli, ...args];
}

/**
 * Ostrzeżenia o argumentach `--inspect` przekazywanych do Next (Next sam otwiera inspektor we właściwym
 * procesie). Bez `--inspect` flaga sieciowa nic nie daje; host spoza loopbacku wystawia pełną kontrolę
 * nad procesem w sieci. Sam port (`--inspect=9231`) oznacza 127.0.0.1.
 * @param {string[]} args
 * @returns {string[]}
 */
export function inspectWarnings(args) {
  const values = inspectorValues(args, /^--inspect(?:-brk|-wait)?(?:=(.*))?$/);
  if (!values.length) return ['No --inspect=<port> in the arguments: the process will have no inspector, so network inspection does nothing. Add e.g. --inspect=9231 (each app in a monorepo needs its own port).'];
  return remoteInspectHosts(args).map(host =>
    `The inspector on ${host} is reachable from outside this machine and gives full control over the process. Locally, use just the port (--inspect=<port> → 127.0.0.1).`);
}

const INSPECT_ANY = /^--(?:inspect(?:-brk|-wait)?|inspect-port|debug-port)(?:=(.*))?$/;

/** Wartości flag inspektora: `--flag=v` albo `--flag v` (gdy następny argument nie jest flagą). */
function inspectorValues(args, re) {
  return args.flatMap((a, i) => {
    const m = re.exec(a);
    if (!m) return [];
    return [m[1] ?? (args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : '')];
  });
}

/** Host z wartości flagi: sam port → brak hosta; `[::]:9229`; `0.0.0.0:9229`; sam host (`--inspect=0.0.0.0`). */
export function inspectorHost(v) {
  if (!v || /^\d+$/.test(v)) return '';
  if (v.startsWith('[')) return v.slice(0, v.indexOf(']') + 1);
  const i = v.lastIndexOf(':');
  return i >= 0 ? v.slice(0, i) : v;
}

/**
 * Hosty inspektora spoza pętli zwrotnej w argumentach i w NODE_OPTIONS, także `--inspect=0.0.0.0` (sam host)
 * i `--inspect-port` / `--debug-port` (audyt B-08).
 * @param {string[]} args  @param {Record<string, string | undefined>} [env]
 */
export function remoteInspectHosts(args, env = {}) {
  const all = [...args, ...String(env.NODE_OPTIONS ?? '').split(/\s+/).filter(Boolean)];
  return [...new Set(inspectorValues(all, INSPECT_ANY).map(inspectorHost).filter(h => h && !LOOPBACK.has(h)))];
}

/** Sygnały przekazywane od razu. SIGBREAK istnieje tylko na Windows (Ctrl+Break). */
const forwarded = platform => ['SIGTERM', 'SIGHUP', ...(platform === 'win32' ? ['SIGBREAK'] : [])];

/**
 * Uruchamia `node <nodeArgs>` z dziedziczonym stdio (TTY, kolory) i czeka na koniec.
 * SIGTERM, SIGHUP (i SIGBREAK na Windows) trafiają do potomka od razu. SIGINT z terminala dostaje cała
 * grupa procesów (na Windows: wszystkie procesy konsoli), więc nie jest dublowany; gdy jednak przyszedł
 * tylko do nas (np. od narzędzia, które zabija sam pid), po `sigintGraceMs` przekazujemy go dalej.
 * @param {{ execPath: string, nodeArgs: string[], proc?: NodeJS.Process, sigintGraceMs?: number,
 *   spawnImpl?: typeof spawn }} input
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, error?: Error }>}
 */
export function runChild({ execPath, nodeArgs, proc = process, sigintGraceMs = 1500, spawnImpl = spawn }) {
  return new Promise(resolve => {
    const child = spawnImpl(execPath, nodeArgs, { stdio: 'inherit' });
    const alive = () => child.exitCode === null && child.signalCode === null;
    const send = sig => { if (alive()) try { child.kill(sig); } catch { /* proces właśnie się skończył */ } };
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
 * Odtwarza zakończenie potomka: kod wyjścia albo ten sam sygnał (POSIX). Na Windows nie ma sygnałów
 * POSIX, więc proces kończy się kodem 128 + numer sygnału, jak w powłokach.
 * @param {{ code: number | null, signal: NodeJS.Signals | null }} result
 */
export function exitLike({ code, signal }, proc = process) {
  if (signal) {
    if (proc.platform !== 'win32') proc.kill(proc.pid, signal);   // nasze nasłuchy już zdjęte → domyślna akcja
    return proc.exit(128 + (constants.signals[signal] ?? 0));
  }
  return proc.exit(code ?? 1);
}

/**
 * Punkt wejścia `outbound-next`: `outbound-next dev --port 3101 --inspect=9231`.
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
  // inspektor poza pętlą zwrotną daje każdemu w sieci wykonanie kodu w procesie: blokada, chyba że jawnie dozwolone
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
