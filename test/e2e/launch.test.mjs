// `outbound-next` (issue #5): a portable replacement for `node --experimental-network-inspection $(node -p …)`.
// Without Next.js: the module to run is given by OUTBOUND_NEXT_BIN or a fake `next` in node_modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcp } from '../helpers/mcp-client.mjs';
import { freePorts } from '../helpers/scenario.mjs';

// ports from the system: test files run in parallel, fixed numbers collided
const [P1, P2, P3, P4] = await freePorts(4);

const BIN = fileURLToPath(new URL('../../bin/outbound-next.mjs', import.meta.url));
const FAKE_NEXT = fileURLToPath(new URL('../fixtures/fake-next.mjs', import.meta.url));
const FLAG = '--experimental-network-inspection';

/** Runs `node [nodeFlags] bin/outbound-next.mjs …args` and collects the output. */
function launch(args, { cwd = process.cwd(), env = { OUTBOUND_NEXT_BIN: FAKE_NEXT }, nodeFlags = [] } = {}) {
  const p = spawn(process.execPath, [...nodeFlags, BIN, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.setEncoding('utf8').on('data', d => { out += d; });
  p.stderr.setEncoding('utf8').on('data', d => { err += d; });
  const exited = new Promise(r => p.on('exit', (code, signal) => r({ code, signal, out, err })));
  const firstLine = new Promise((resolve, reject) => {
    p.stdout.on('data', () => { const i = out.indexOf('\n'); if (i >= 0) resolve(JSON.parse(out.slice(0, i))); });
    exited.then(r => reject(new Error(`the process ended without output: ${JSON.stringify(r)}`)));
  });
  firstLine.catch(() => {});                                            // a test without output does not wait for the line
  return { p, firstLine, exited };
}

test('child process: the network flag in execArgv, the inspector on the given port, arguments and exit code', async () => {
  const args = ['dev', '--port', '3101', `--inspect=${P1}`, 'with space'];
  const run = launch(args);
  const child = await run.firstLine;
  assert.ok(child.execArgv.includes(FLAG), 'the flag on the command line (not in NODE_OPTIONS)');
  assert.deepEqual(child.argv, args, 'arguments unchanged, also with a space');
  assert.ok(child.inspectorUrl.startsWith(`ws://127.0.0.1:${P1}/`), child.inspectorUrl);
  assert.notEqual(child.pid, run.p.pid, 'a separate child process');
  assert.equal(child.optIn, '1', 'consent to inspection for the collector (OUTBOUND_INSPECT=1, audit B-01)');
  const targets = await fetch(`http://127.0.0.1:${P1}/json/list`).then(r => r.json());
  assert.equal(targets.length, 1);
  // the tool sees a process started this way as an app with network inspection
  const mcp = await startMcp({ env: { INSPECTOR_PORTS: String(P1), APP_NAMES: `${P1}=fake-next` }, stderr: 'ignore' });
  try {
    const s = await mcp.waitForApps(1);
    assert.equal(s.apps[0].app, 'fake-next');
    assert.equal(s.apps[0].pid, child.pid);
  } finally { mcp.close(); }
  run.p.stdin.end('exit 7\n');
  const r = await run.exited;
  assert.equal(r.code, 7, 'the child exit code passes through');
  assert.doesNotMatch(r.err, /warning/);
});

test('without --inspect: a warning instead of a silent missing inspector; node flags pass, --inspect does not', async () => {
  const run = launch(['dev'], { nodeFlags: ['--no-deprecation', '--inspect-port=0'] });
  const child = await run.firstLine;
  assert.equal(child.inspectorUrl, null);
  assert.ok(child.execArgv.includes('--no-deprecation'));
  assert.ok(!child.execArgv.some(a => a.startsWith('--inspect')), 'the inspector port belongs to the app, not the launcher');
  run.p.stdin.end();
  const r = await run.exited;
  assert.equal(r.code, 0);
  assert.match(r.err, /\[outbound-next\] warning: No --inspect=<port>/);
});

test('non-loopback inspector host: blocked by default, a warning with OUTBOUND_ALLOW_REMOTE_INSPECT=1', async () => {
  const blocked = await launch(['dev', '--inspect=0.0.0.0']).exited;
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /reachable from outside this machine.*OUTBOUND_ALLOW_REMOTE_INSPECT=1/s);
  const run = launch(['dev', `--inspect=0.0.0.0:${P2}`], { env: { OUTBOUND_NEXT_BIN: FAKE_NEXT, OUTBOUND_ALLOW_REMOTE_INSPECT: '1' } });
  await run.firstLine;
  run.p.stdin.end();
  const r = await run.exited;
  assert.match(r.err, /warning: The inspector on 0\.0\.0\.0 is reachable from outside this machine/);
});

test('SIGTERM reaches the child, and the launcher ends with the same signal', { skip: process.platform === 'win32' && 'no POSIX signals' }, async () => {
  const run = launch(['dev', `--inspect=${P3}`]);
  await run.firstLine;
  run.p.kill('SIGTERM');
  const r = await run.exited;
  assert.equal(r.signal, 'SIGTERM');
  await assert.rejects(fetch(`http://127.0.0.1:${P3}/json/list`), 'the child is dead');
});

test('resolves next from node_modules: app, hoisted monorepo, pnpm-like symlink', async t => {
  const root = mkdtempSync(join(tmpdir(), 'outbound-next-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeNext = (dir, label) => {
    mkdirSync(join(dir, 'next/dist/bin'), { recursive: true });
    writeFileSync(join(dir, 'next/package.json'), '{"name":"next","version":"0.0.0-test"}');
    // the real next/dist/bin/next is CommonJS without an extension
    writeFileSync(join(dir, 'next/dist/bin/next'), `console.log(JSON.stringify({ label: ${JSON.stringify(label)}, execArgv: process.execArgv, argv: process.argv.slice(2) })); process.exitCode = 3;\n`);
  };
  const app = (name, deps = '') => { const d = join(root, name); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'package.json'), `{"name":"${name}"${deps}}`); return d; };
  fakeNext(join(root, 'node_modules'), 'hoisted');                     // npm/bun/yarn: the root directory
  fakeNext(join(root, '.store'), 'pnpm');                              // pnpm: store + symlink in the app
  const hoisted = app('apps/web');
  const pnpm = app('apps/admin');
  mkdirSync(join(pnpm, 'node_modules'));
  symlinkSync(join(root, '.store/next'), join(pnpm, 'node_modules/next'), 'junction');
  for (const [cwd, label] of [[hoisted, 'hoisted'], [pnpm, 'pnpm']]) {
    const run = launch(['dev', `--inspect=${P4}`], { cwd, env: { OUTBOUND_NEXT_BIN: '' } });
    const child = await run.firstLine;
    assert.equal(child.label, label);
    assert.ok(child.execArgv.includes(FLAG));
    assert.deepEqual(child.argv, ['dev', `--inspect=${P4}`]);
    assert.equal((await run.exited).code, 3);
  }
});

test('no next: a readable error and code 1', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'outbound-next-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await launch(['dev'], { cwd: dir, env: { OUTBOUND_NEXT_BIN: '' } }).exited;
  assert.equal(r.code, 1);
  assert.match(r.err, /Could not find next\/dist\/bin\/next .*OUTBOUND_NEXT_BIN/);
});
