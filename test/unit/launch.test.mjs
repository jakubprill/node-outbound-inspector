// Części launchera `outbound-next` bez procesów: argumenty node, ostrzeżenia, sygnały, kod wyjścia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildNodeArgs, inspectWarnings, resolveCli, runChild, exitLike, NETWORK_FLAG } from '../../src/cli/launch.mjs';

test('buildNodeArgs: flaga przed plikiem CLI, flagi inspektora launchera odfiltrowane', () => {
  assert.deepEqual(buildNodeArgs({ cli: '/n/next', args: ['dev', '--inspect=9231'] }), [NETWORK_FLAG, '/n/next', 'dev', '--inspect=9231']);
  assert.deepEqual(
    buildNodeArgs({ cli: 'c', args: [], execArgv: ['--inspect=9229', '--inspect-brk', '--debug-port=1', NETWORK_FLAG, '--import', './x.mjs', '--max-old-space-size=4096'] }),
    ['--import', './x.mjs', '--max-old-space-size=4096', NETWORK_FLAG, 'c']);
});

test('inspectWarnings: brak inspektora i host spoza loopbacku', () => {
  assert.equal(inspectWarnings(['dev']).length, 1);
  for (const ok of [['--inspect=9231'], ['--inspect'], ['--inspect=127.0.0.1:9231'], ['--inspect=localhost:1'], ['--inspect=[::1]:9231'], ['--inspect-brk=9231']])
    assert.deepEqual(inspectWarnings(['dev', ...ok]), [], ok.join(' '));
  assert.match(inspectWarnings(['dev', '--inspect=0.0.0.0:9231'])[0], /0\.0\.0\.0/);
  assert.match(inspectWarnings(['dev', '--inspect', '10.0.0.5:9231'])[0], /10\.0\.0\.5/);
});

test('resolveCli: OUTBOUND_NEXT_BIN względem cwd, inaczej require.resolve z cwd', () => {
  assert.equal(resolveCli({ cwd: '/repo/apps/web', env: { OUTBOUND_NEXT_BIN: '../../tools/next.mjs' } }).replaceAll('\\', '/').replace(/^[A-Z]:/, ''), '/repo/tools/next.mjs');
  assert.throws(() => resolveCli({ cwd: '/nie/ma/takiego', env: {} }), { code: 'MODULE_NOT_FOUND' });
});

function fakes(platform = 'linux') {
  const proc = Object.assign(new EventEmitter(), { platform });
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, sent: [], kill(sig) { this.sent.push(sig); } });
  const spawnImpl = (execPath, args, opts) => { Object.assign(child, { execPath, args, opts }); return child; };
  return { proc, child, spawnImpl };
}

test('runChild: stdio dziedziczone, SIGTERM/SIGHUP od razu, SIGINT dopiero po czasie łaski, nasłuchy zdjęte', async () => {
  const { proc, child, spawnImpl } = fakes();
  const done = runChild({ execPath: '/bin/node', nodeArgs: ['a'], proc, spawnImpl, sigintGraceMs: 30 });
  assert.equal(child.opts.stdio, 'inherit');
  assert.deepEqual(child.args, ['a']);
  proc.emit('SIGTERM'); proc.emit('SIGHUP');
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP']);
  proc.emit('SIGINT');
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP'], 'SIGINT z terminala dostaje już cała grupa');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(child.sent, ['SIGTERM', 'SIGHUP', 'SIGINT'], 'potomek nie skończył się sam → przekazany');
  child.signalCode = 'SIGINT'; child.emit('exit', null, 'SIGINT');
  assert.deepEqual(await done, { code: null, signal: 'SIGINT' });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(proc.listenerCount(s), 0, s);
});

test('runChild: SIGINT nie jest przekazywany, gdy potomek kończy się sam; Windows: SIGBREAK', async () => {
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

test('exitLike: kod wyjścia; sygnał ponownie na POSIX, 128+n na Windows', () => {
  const calls = [];
  const proc = platform => ({ platform, pid: 42, kill: (...a) => calls.push(['kill', ...a]), exit: c => calls.push(['exit', c]) });
  exitLike({ code: 7, signal: null }, proc('linux'));
  exitLike({ code: null, signal: 'SIGTERM' }, proc('linux'));
  exitLike({ code: null, signal: 'SIGTERM' }, proc('win32'));
  assert.deepEqual(calls, [['exit', 7], ['kill', 42, 'SIGTERM'], ['exit', 143], ['exit', 143]]);
});
