// Parts of the `outbound-next` launcher without processes: node arguments, warnings, signals, exit code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildNodeArgs, inspectWarnings, remoteInspectHosts, resolveCli, runChild, exitLike, NETWORK_FLAG } from '../../src/cli/launch.mjs';

test('buildNodeArgs: the flag before the CLI file, the launcher inspector flags filtered out', () => {
  assert.deepEqual(buildNodeArgs({ cli: '/n/next', args: ['dev', '--inspect=9231'] }), [NETWORK_FLAG, '/n/next', 'dev', '--inspect=9231']);
  assert.deepEqual(
    buildNodeArgs({ cli: 'c', args: [], execArgv: ['--inspect=9229', '--inspect-brk', '--debug-port=1', NETWORK_FLAG, '--import', './x.mjs', '--max-old-space-size=4096'] }),
    ['--import', './x.mjs', '--max-old-space-size=4096', NETWORK_FLAG, 'c']);
});

test('inspectWarnings: no inspector and a non-loopback host', () => {
  assert.equal(inspectWarnings(['dev']).length, 1);
  for (const ok of [['--inspect=9231'], ['--inspect=127.0.0.1:9231'], ['--inspect=localhost:1'], ['--inspect=[::1]:9231'], ['--inspect-brk=9231']])
    assert.deepEqual(inspectWarnings(['dev', ...ok]), [], ok.join(' '));
  assert.match(inspectWarnings(['dev', '--inspect=0.0.0.0:9231'])[0], /0\.0\.0\.0/);
  assert.match(inspectWarnings(['dev', '--inspect', '10.0.0.5:9231'])[0], /10\.0\.0\.5/);
});

test('inspectWarnings: --inspect without a port → 9229 (the hub port, a monorepo collision, e.g. portless -- --inspect)', () => {
  for (const args of [['--inspect'], ['--inspect=127.0.0.1'], ['--inspect-brk'], ['--inspect', '--port', '3000']]) {
    const w = inspectWarnings(['dev', ...args]);
    assert.equal(w.length, 1, args.join(' '));
    assert.match(w[0], /without a port uses 9229/);
  }
  assert.equal(inspectWarnings(['dev', '--inspect=0.0.0.0']).length, 2, 'a non-loopback host and no port');
});

test('remoteInspectHosts: host only, --inspect-port, NODE_OPTIONS, IPv6 (audit B-08)', () => {
  assert.deepEqual(remoteInspectHosts(['dev', '--inspect=0.0.0.0']), ['0.0.0.0']);
  assert.deepEqual(remoteInspectHosts(['dev', '--inspect', 'myhost.lan']), ['myhost.lan']);
  assert.deepEqual(remoteInspectHosts(['--inspect=9231', '--inspect-port=0.0.0.0:9231']), ['0.0.0.0']);
  assert.deepEqual(remoteInspectHosts(['dev', '--inspect=[::]:9229']), ['[::]']);
  assert.deepEqual(remoteInspectHosts(['dev', '--inspect=9231'], { NODE_OPTIONS: '--max-old-space-size=4096 --inspect=0.0.0.0:9230' }), ['0.0.0.0']);
  for (const ok of [['--inspect=9231'], ['--inspect=127.0.0.1:9231'], ['--inspect=localhost'], ['--inspect=[::1]:9231'], ['--debug-port=9231']])
    assert.deepEqual(remoteInspectHosts(ok), [], ok.join(' '));
});

test('resolveCli: OUTBOUND_NEXT_BIN relative to cwd, otherwise require.resolve from cwd', () => {
  assert.equal(resolveCli({ cwd: '/repo/apps/web', env: { OUTBOUND_NEXT_BIN: '../../tools/next.mjs' } }).replaceAll('\\', '/').replace(/^[A-Z]:/, ''), '/repo/tools/next.mjs');
  assert.throws(() => resolveCli({ cwd: '/no/such/dir', env: {} }), { code: 'MODULE_NOT_FOUND' });
});

function fakes(platform = 'linux') {
  const proc = Object.assign(new EventEmitter(), { platform });
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, sent: [], kill(sig) { this.sent.push(sig); } });
  const spawnImpl = (execPath, args, opts) => { Object.assign(child, { execPath, args, opts }); return child; };
  return { proc, child, spawnImpl };
}

test('runChild: inherited stdio, SIGTERM/SIGHUP immediately, SIGINT only after the grace period, listeners removed', async () => {
  const { proc, child, spawnImpl } = fakes();
  const done = runChild({ execPath: '/bin/node', nodeArgs: ['a'], proc, spawnImpl, sigintGraceMs: 30 });
  assert.equal(child.opts.stdio, 'inherit');
  assert.deepEqual(child.args, ['a']);
  proc.emit('SIGTERM'); proc.emit('SIGHUP');
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP']);
  proc.emit('SIGINT');
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP'], 'SIGINT from the terminal already reaches the whole group');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP', 'SIGINT'], 'the child did not end by itself → forwarded');
  child.signalCode = 'SIGINT'; child.emit('exit', null, 'SIGINT');
  assert.deepEqual(await done, { code: null, signal: 'SIGINT' });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(proc.listenerCount(s), 0, s);
});

test('runChild: SIGINT is not forwarded when the child ends by itself; Windows: SIGBREAK', async () => {
  const { proc, child, spawnImpl } = fakes('win32');
  const done = runChild({ execPath: 'node.exe', nodeArgs: [], proc, spawnImpl, sigintGraceMs: 30 });
  proc.emit('SIGINT');
  child.exitCode = 0; child.emit('exit', 0, null);
  await done;
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(child.sent, []);
  const second = fakes('win32');
  runChild({ execPath: 'node.exe', nodeArgs: [], proc: second.proc, spawnImpl: second.spawnImpl });
  second.proc.emit('SIGBREAK');
  assert.deepEqual(second.child.sent, ['SIGBREAK']);
  second.child.emit('exit', 1, null);
});

test('exitLike: exit code; the signal again on POSIX, 128+n on Windows', () => {
  const calls = [];
  const proc = platform => ({ platform, pid: 42, kill: (...a) => calls.push(['kill', ...a]), exit: c => calls.push(['exit', c]) });
  exitLike({ code: 7, signal: null }, proc('linux'));
  exitLike({ code: null, signal: 'SIGTERM' }, proc('linux'));
  exitLike({ code: null, signal: 'SIGTERM' }, proc('win32'));
  assert.deepEqual(calls, [['exit', 7], ['kill', 42, 'SIGTERM'], ['exit', 143], ['exit', 143]]);
});
